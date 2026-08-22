#!/usr/bin/env python3
"""Focused synthetic validation for the bundled chroma-key helper."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "remove_chroma_key.py"


class RemoveChromaKeyTest(unittest.TestCase):
    def test_synthetic_green_background_becomes_transparent(self) -> None:
        with tempfile.TemporaryDirectory(prefix="azure-imagegen-key-") as raw_dir:
            directory = Path(raw_dir)
            source = directory / "source.png"
            output = directory / "output.png"
            image = Image.new("RGB", (12, 12), (0, 255, 0))
            for x in range(4, 8):
                for y in range(4, 8):
                    image.putpixel((x, y), (220, 20, 20))
            image.save(source)

            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--input",
                    str(source),
                    "--out",
                    str(output),
                    "--auto-key",
                    "border",
                    "--soft-matte",
                    "--despill",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertIn("Transparent pixels:", completed.stdout)
            with Image.open(output) as result:
                self.assertEqual(result.mode, "RGBA")
                self.assertEqual(result.getpixel((0, 0))[3], 0)
                self.assertEqual(result.getpixel((5, 5))[3], 255)


if __name__ == "__main__":
    unittest.main()
