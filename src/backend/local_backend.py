import argparse
import base64
import json
import os
import re
import sys
import tempfile
from functools import lru_cache
from urllib import error, request


DEFAULT_API_BASE_URL = "https://api.xiaomimimo.com/v1"
DEFAULT_CLOUD_MODEL = "mimo-v2-omni"


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


@lru_cache(maxsize=2)
def get_whisper_model(model_name: str):
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception:
        fail(
            "Missing Python dependency 'faster-whisper'. Install requirements.txt before running the app."
        )

    return WhisperModel(model_name or "medium", device="cpu", compute_type="int8")


def transcribe_audio(wav_path: str, model_name: str) -> tuple[str, str]:
    model = get_whisper_model(model_name or "medium")
    segments, info = model.transcribe(
        wav_path,
        vad_filter=True,
        vad_parameters={
            "min_silence_duration_ms": 650,
        },
        beam_size=3,
        condition_on_previous_text=False,
    )

    transcript = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
    language = (info.language or "").lower()
    return transcript.strip(), language


def get_target_language(source_language: str) -> str:
    if source_language.startswith("zh"):
        return "en"
    return "zh"


@lru_cache(maxsize=1)
def get_simplifier():
    try:
        from opencc import OpenCC  # type: ignore
    except Exception:
        return None

    return OpenCC("t2s")


def to_simplified_chinese(text: str) -> str:
    simplifier = get_simplifier()
    if simplifier is None or not text:
        return text

    return simplifier.convert(text)


def normalize_source_language(language: str) -> str:
    lowered = (language or "").strip().lower()
    if lowered.startswith("zh") or "chinese" in lowered or "mandarin" in lowered:
        return "zh"
    if lowered.startswith("en") or "english" in lowered:
        return "en"
    return lowered


def translate_text(text: str, source_language: str) -> str:
    if not text:
        return ""

    try:
        from argostranslate import translate  # type: ignore
    except Exception:
        fail(
            "Missing Python dependency 'argostranslate'. Install requirements.txt before running the app."
        )

    source_code = "zh" if source_language.startswith("zh") else "en"
    target_code = get_target_language(source_language)

    installed_languages = translate.get_installed_languages()
    from_lang = next((lang for lang in installed_languages if lang.code == source_code), None)
    to_lang = next((lang for lang in installed_languages if lang.code == target_code), None)

    if from_lang is None or to_lang is None:
        fail(
            f"Argos Translate language package for {source_code}->{target_code} is missing. Please install it before running."
        )

    translator = from_lang.get_translation(to_lang)
    translation = translator.translate(text).strip()

    if target_code == "zh":
        return to_simplified_chinese(translation)

    return translation


def parse_json_response(raw_text: str) -> dict:
    stripped = raw_text.strip()
    if not stripped:
        raise ValueError("MiMo API returned an empty response.")

    candidates = []

    if stripped.startswith("```"):
      cleaned = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", stripped)
      cleaned = re.sub(r"\s*```$", "", cleaned)
      candidates.append(cleaned.strip())

    start = stripped.find("{")
    end = stripped.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidates.append(stripped[start : end + 1].strip())

    candidates.append(stripped)

    normalized_candidates = []
    for candidate in candidates:
        if not candidate:
            continue
        normalized_candidates.append(candidate)
        normalized_candidates.append(
            candidate.replace("：", ":").replace("，", ",").replace("“", "\"").replace("”", "\"")
        )

    seen = set()
    for candidate in normalized_candidates:
        if candidate in seen:
            continue
        seen.add(candidate)

        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

        try:
            repaired = re.sub(r"(?P<key>[{,\s])'(?P<name>[^']+?)'\s*:", r'\g<key>"\g<name>":', candidate)
            repaired = re.sub(r':\s*\'([^\']*)\'', lambda match: ': ' + json.dumps(match.group(1)), repaired)
            return json.loads(repaired)
        except json.JSONDecodeError:
            pass

    transcript_match = re.search(r'"transcript"\s*:\s*"(?P<value>.*?)"', stripped, re.DOTALL)
    translation_match = re.search(r'"translation"\s*:\s*"(?P<value>.*?)"', stripped, re.DOTALL)
    language_match = re.search(r'"source_language"\s*:\s*"(?P<value>.*?)"', stripped, re.DOTALL)

    if transcript_match or translation_match or language_match:
        return {
            "source_language": language_match.group("value") if language_match else "",
            "transcript": transcript_match.group("value") if transcript_match else "",
            "translation": translation_match.group("value") if translation_match else "",
        }

    raise ValueError(f"MiMo API returned non-JSON text: {stripped[:240]}")


def extract_message_text(response_body: dict) -> str:
    choices = response_body.get("choices") or []
    if not choices:
        raise ValueError("MiMo API response did not contain choices.")

    message = choices[0].get("message") or {}
    content = message.get("content")
    reasoning_content = message.get("reasoning_content")

    if isinstance(content, str) and content.strip():
        return content

    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        joined = "\n".join(part for part in parts if part).strip()
        if joined:
            return joined

    if isinstance(reasoning_content, str) and reasoning_content.strip():
        return reasoning_content

    raise ValueError("MiMo API response did not contain readable text content.")


def request_mimo_transcription(audio_base64: str, settings: dict) -> dict:
    api_key = (settings.get("mimoApiKey") or "").strip()
    if not api_key:
        raise ValueError("MiMo API key is missing. Please fill it in Settings before using cloud mode.")

    api_base_url = (settings.get("apiBaseUrl") or DEFAULT_API_BASE_URL).rstrip("/")
    cloud_model = (settings.get("cloudModel") or DEFAULT_CLOUD_MODEL).strip() or DEFAULT_CLOUD_MODEL

    prompt = (
        "You are a speech subtitle engine. "
        "Listen to the provided audio and return only strict JSON with three fields: "
        "source_language, transcript, translation. "
        "If the speech is mainly Chinese, set source_language to zh, keep transcript in simplified Chinese, "
        "and translate to natural English. "
        "If the speech is mainly English, set source_language to en, keep transcript in English, "
        "and translate to natural simplified Chinese. "
        "Do not include markdown fences or extra commentary. "
        "Put the final JSON into message.content, not reasoning_content."
    )

    payload = {
        "model": cloud_model,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": prompt,
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": audio_base64,
                            "format": "wav",
                        },
                    },
                ],
            },
        ],
    }

    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"{api_base_url}/chat/completions",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        with request.urlopen(req, timeout=120) as response:
            response_text = response.read().decode("utf-8")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ValueError(f"MiMo API error {exc.code}: {detail[:400]}")
    except error.URLError as exc:
        raise ValueError(f"Could not reach MiMo API: {exc.reason}")

    response_body = json.loads(response_text)
    message_text = extract_message_text(response_body)
    result = parse_json_response(message_text)

    source_language = normalize_source_language(str(result.get("source_language", "")))
    transcript = str(result.get("transcript", "")).strip()
    translation = str(result.get("translation", "")).strip()

    if source_language.startswith("zh"):
        transcript = to_simplified_chinese(transcript)
    if source_language.startswith("en"):
        translation = to_simplified_chinese(translation)

    return {
        "source_language": source_language,
        "transcript": transcript,
        "translation": translation,
    }


def process_payload(payload: dict) -> dict:
    audio_base64 = payload.get("audioBase64", "")
    settings = payload.get("settings", {})
    backend_mode = (settings.get("backendMode") or "local").strip().lower()
    model_name = settings.get("whisperModel", "medium")

    if not audio_base64:
        return {"transcript": "", "translation": "", "source_language": ""}

    if backend_mode == "mimo":
        return request_mimo_transcription(audio_base64, settings)

    wav_bytes = base64.b64decode(audio_base64)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
        temp_file.write(wav_bytes)
        temp_path = temp_file.name

    try:
        transcript, language = transcribe_audio(temp_path, model_name)
        language = normalize_source_language(language)
        if language.startswith("zh"):
            transcript = to_simplified_chinese(transcript)
        translation = translate_text(transcript, language)
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass

    return {
        "transcript": transcript,
        "translation": translation,
        "source_language": language,
    }


def serve() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue

        try:
            message = json.loads(line)
            request_id = message.get("id")
            result = process_payload(message)
            response = {"id": request_id, "result": result}
        except Exception as exc:
            response = {"id": message.get("id") if "message" in locals() else None, "error": str(exc)}

        print(json.dumps(response, ensure_ascii=True), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()

    if args.serve:
        serve()
        return

    payload = json.load(sys.stdin)
    result = process_payload(payload)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
