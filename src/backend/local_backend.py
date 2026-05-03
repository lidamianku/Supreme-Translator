import base64
import json
import os
import argparse
import sys
import tempfile
from functools import lru_cache


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
    segments, _info = model.transcribe(
        wav_path,
        vad_filter=True,
        vad_parameters={
            "min_silence_duration_ms": 650,
        },
        beam_size=3,
        condition_on_previous_text=False,
    )

    transcript = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
    language = (_info.language or "").lower()
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


def translate_text(text: str, source_language: str) -> str:
    if not text:
        return ""

    try:
      from argostranslate import package, translate  # type: ignore
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


def process_payload(payload: dict) -> dict:
    audio_base64 = payload.get("audioBase64", "")
    settings = payload.get("settings", {})
    model_name = settings.get("whisperModel", "medium")

    if not audio_base64:
        return {"transcript": "", "translation": ""}

    wav_bytes = base64.b64decode(audio_base64)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
        temp_file.write(wav_bytes)
        temp_path = temp_file.name

    try:
        transcript, language = transcribe_audio(temp_path, model_name)
        if language.startswith("zh"):
            transcript = to_simplified_chinese(transcript)
        translation = translate_text(transcript, language)
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass

    return {"transcript": transcript, "translation": translation}


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


if __name__ == "__main__":
    main()
