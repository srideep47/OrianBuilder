import sys

import onnxruntime as ort


def main() -> int:
    providers = ort.get_available_providers()
    print("Available ONNX Runtime providers:")
    for provider in providers:
        print(f"- {provider}")

    if "DmlExecutionProvider" not in providers:
        print(
            "\nDmlExecutionProvider is missing. Install onnxruntime-directml and "
            "remove any CPU-only onnxruntime package from this environment."
        )
        return 1

    print("\nDirectML is available.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

