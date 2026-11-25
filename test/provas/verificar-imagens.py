"""Confere pixels realmente impressos e coordenadas do texto vetorial no PDF."""
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

from PIL import Image, ImageChops

pasta, amostras = map(Path, sys.argv[1:])
with Image.open(pasta / "legado.png") as atual, Image.open(amostras / "pagina-v1.png") as referencia:
    assert atual.size == referencia.size
    assert ImageChops.difference(atual.convert("RGB"), referencia.convert("RGB")).getbbox() is None, "A apresentação v1 mudou"

subprocess.run(["pdftoppm", "-r", "96", "-png", str(pasta / "ata.pdf"), str(pasta / "pdf")], check=True)

def caixa(imagem, cor):
    # A cor sólida identifica a marca até o limite do recorte.
    mask = ImageChops.difference(imagem, Image.new("RGB", imagem.size, cor)).convert("L").point(lambda v: 255 if v < 3 else 0)
    return mask.getbbox()

for n in (1, 2):
    for origem in ("pdf", "navegador"):
        with Image.open(pasta / f"{origem}-{n}.png") as image:
            # Só o primeiro quarto da página contém o cabeçalho.
            recorte = image.convert("RGB").crop((0, 0, image.width, 155))
            marca = caixa(recorte, "#38586e")
            if n == 1:
                assert marca and all(abs(x-y) <= 2 for x,y in zip(marca, (76, 76, 227, 151))), (origem, marca)
                for cor in ("#ed980b", "#b23c55"):
                    faixa = caixa(recorte, cor)
                    # O limite fracionário em cm pode atravessar um pixel na rasterização.
                    assert faixa is None or faixa[3] - faixa[1] <= 1, ("Faixa externa visível", faixa)
            else:
                assert marca is None, "Logo repetido na segunda página"

bbox = subprocess.check_output(["pdftotext", "-bbox-layout", str(pasta / "ata.pdf"), "-"])
paginas = ET.fromstring(bbox).findall(".//{*}page")
assert len(paginas) == 2
def linhas(page):
    for line in page.findall(".//{*}line"):
        yield " ".join(w.text or "" for w in line.findall("{*}word")), float(line.attrib["xMin"]), float(line.attrib["yMin"])
primeira = list(linhas(paginas[0]))
segunda = list(linhas(paginas[1]))
nota = next(y for txt, x, y in primeira if "Edital lido" in txt)
rodape = next(y for txt, x, y in primeira if "Acervo da Secretaria" in txt)
assert rodape > nota > 700 and all("Edital lido" not in txt for txt, _, _ in segunda)
primeira_linha = next((x, y) for txt, x, y in primeira if txt.startswith("O conselho examinou a ilustra"))
x, y = primeira_linha
contorno = [xl for _, xl, yl in primeira if y <= yl < y + 80 and xl > 60]
assert len(contorno) >= 3 and max(contorno) - min(contorno) > 25, contorno
print("PDF e navegador conferidos. Duas folhas, recorte de 2 cm, contorno do PNG e nota na folha da referência. Legado idêntico à referência.")
