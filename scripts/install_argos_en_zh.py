from argostranslate import package


def main() -> None:
    package.update_package_index()
    available_packages = package.get_available_packages()

    targets = [("en", "zh"), ("zh", "en")]

    for from_code, to_code in targets:
        target_package = next(
            (
                item
                for item in available_packages
                if item.from_code == from_code and item.to_code == to_code
            ),
            None,
        )

        if target_package is None:
            raise SystemExit(
                f"Could not find an Argos Translate package for {from_code} -> {to_code}."
            )

        download_path = target_package.download()
        package.install_from_path(download_path)
        print(f"Installed {target_package.from_code} -> {target_package.to_code}.")


if __name__ == "__main__":
    main()
