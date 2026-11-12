"""Writes the PDF fixtures in tests/fixtures/pdf (run with PyMuPDF and Pillow installed: python3 tests/fixtures/gen_pdf_fixtures.py).

The files are committed, so tests need neither Python nor these packages. Every fixture is small and synthetic.
"""

import io
import sys
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent / "pdf"
A4_LANDSCAPE = (842, 595)


def scanned_png(lines: list[str], size=(1200, 850)) -> bytes:
    """A picture of text, as a scanner would produce: there is no text layer, only pixels."""
    img = Image.new("L", size, 255)
    draw = ImageDraw.Draw(img)
    y = 80
    for line in lines:
        draw.text((80, y), line, fill=0, font_size=56)
        y += 110
    draw.rectangle((60, 60, size[0] - 60, size[1] - 60), outline=0, width=6)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=70)
    return buf.getvalue()


def text_lecture() -> bytes:
    doc = pymupdf.open()
    doc.set_metadata({"title": "운영체제 3강", "author": "테스트", "producer": "studyai fixtures"})

    p1 = doc.new_page(width=A4_LANDSCAPE[0], height=A4_LANDSCAPE[1])
    p1.insert_text((60, 90), "프로세스 스케줄링", fontname="korea", fontsize=34)
    y = 160
    for item in ["• 선점형 스케줄링은 실행 중인 프로세스를 중단시킬 수 있다", "• 라운드 로빈은 시간 할당량(time quantum)을 사용한다", "• 문맥 교환 비용이 성능에 영향을 준다"]:
        p1.insert_text((80, y), item, fontname="korea", fontsize=20)
        y += 44
    p1.insert_text((780, 570), "1", fontname="helv", fontsize=10)

    p2 = doc.new_page(width=A4_LANDSCAPE[0], height=A4_LANDSCAPE[1])
    p2.insert_text((60, 90), "교착 상태의 네 가지 조건", fontname="korea", fontsize=30)
    rect = pymupdf.Rect(60, 130, 780, 400)
    p2.insert_textbox(rect, "상호 배제, 점유 대기, 비선점, 순환 대기가 동시에 성립하면 교착 상태가 발생할 수 있다. Deadlock requires all four Coffman conditions.", fontname="korea", fontsize=18)

    p3 = doc.new_page(width=A4_LANDSCAPE[0], height=A4_LANDSCAPE[1])
    p3.insert_image(pymupdf.Rect(40, 40, 802, 555), stream=scanned_png(["Gantt chart", "P1 P2 P3"]))

    doc.set_toc([[1, "스케줄링", 1], [1, "교착 상태", 2]])
    doc.subset_fonts()
    return doc.tobytes(garbage=4, deflate=True)


def scanned_lecture() -> bytes:
    doc = pymupdf.open()
    for n in (1, 2):
        page = doc.new_page(width=595, height=842)
        page.insert_image(page.rect, stream=scanned_png([f"Scanned page {n}", "no text layer"], size=(850, 1200)))
    return doc.tobytes(garbage=4, deflate=True)


def jpeg2000_scan() -> bytes:
    """A scan stored as JPEG 2000: PDF.js decodes it with its bundled WebAssembly decoder."""
    img = Image.new("RGB", (600, 400), "white")
    draw = ImageDraw.Draw(img)
    draw.rectangle((40, 40, 560, 360), outline="black", width=8)
    draw.text((80, 150), "JPEG 2000 scan", fill="black", font_size=48)
    buf = io.BytesIO()
    img.save(buf, format="JPEG2000")
    doc = pymupdf.open()
    page = doc.new_page(width=600, height=400)
    page.insert_image(page.rect, stream=buf.getvalue())
    return doc.tobytes(garbage=4, deflate=True)


def shared_bookmarks() -> bytes:
    """Headings that start on the same page, as Word and LaTeX exports write them."""
    doc = pymupdf.open()
    for n in (1, 2, 3):
        doc.new_page().insert_text((72, 72), f"Page {n}", fontname="helv", fontsize=14)
    doc.set_toc([[1, "Intro", 1], [1, "Overview", 1], [1, "Part A", 2], [1, "Part B", 2], [1, "Part C", 3]])
    return doc.tobytes(garbage=4, deflate=True)


def encrypted_lecture() -> bytes:
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "secret", fontname="helv", fontsize=12)
    return doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="1234", owner_pw="owner")


def main() -> int:
    OUT.mkdir(exist_ok=True)
    (OUT / "text-lecture.pdf").write_bytes(text_lecture())
    (OUT / "scanned-lecture.pdf").write_bytes(scanned_lecture())
    (OUT / "encrypted.pdf").write_bytes(encrypted_lecture())
    (OUT / "jpeg2000-scan.pdf").write_bytes(jpeg2000_scan())
    (OUT / "shared-bookmarks.pdf").write_bytes(shared_bookmarks())
    good = (OUT / "text-lecture.pdf").read_bytes()
    (OUT / "broken.pdf").write_bytes(good[:200] + b"\x00garbage\x00" * 20)
    for f in sorted(OUT.glob("*.pdf")):
        print(f.name, f.stat().st_size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
