"""
Genera las muestras DICOM de demostración: una periapical esquemática (no es
de un paciente) guardada en cada sintaxis de transferencia que lee el visor.

Se generan con herramientas independientes del visor (pydicom y GDCM) para que
las pruebas comparen el decodificador del navegador contra otra implementación.

    python -m venv .venv
    .venv/Scripts/python -m pip install pydicom==3.0.2 numpy pillow python-gdcm==3.2.6 pylibjpeg pylibjpeg-openjpeg imagecodecs==2026.10.10
    .venv/Scripts/python packages/clinical/samples/dicom/generate.py

Los archivos se versionan; volver a generarlos solo si cambia la muestra.
"""

from pathlib import Path

import gdcm
import imagecodecs
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import (
    JPEG2000,
    JPEG2000Lossless,
    ExplicitVRLittleEndian,
    JPEGExtended12Bit,
    RLELossless,
)

OUT = Path(__file__).resolve().parent
WIDTH, HEIGHT = 200, 150
# Digital Intra-Oral X-Ray Image Storage – For Presentation (PS3.4).
INTRAORAL = "1.2.840.10008.5.1.4.1.1.1.3"


def drawing(variant: int) -> np.ndarray:
    """Tres piezas con raíces y una lesión; `variant` desplaza la lesión."""
    img = Image.new("L", (WIDTH, HEIGHT), 27)
    d = ImageDraw.Draw(img)
    for x in (38, 94, 150):
        d.rounded_rectangle((x - 22, 22, x + 22, 104), radius=15, fill=185)
        d.rounded_rectangle((x - 15, 100, x - 5, 141), radius=4, fill=154)
        d.rounded_rectangle((x + 5, 100, x + 15, 141), radius=4, fill=154)
        d.ellipse((x - 11, 34, x + 11, 59), fill=232)
    cx, cy = 50 + variant * 2, 38 + variant
    d.ellipse((cx - 8, cy - 6, cx + 8, cy + 6), fill=61)
    img = img.filter(ImageFilter.GaussianBlur(0.8))
    rng = np.random.default_rng(34 + variant)
    values = np.asarray(img, dtype=np.float64) / 255 * 4095 + rng.normal(0, 18, (HEIGHT, WIDTH))
    return np.clip(np.round(values), 0, 4095).astype(np.uint16)


def dataset(frames: list[np.ndarray], bits: int = 16) -> Dataset:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = INTRAORAL
    meta.MediaStorageSOPInstanceUID = "2.25.340000000000000000000000000000000001"
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = INTRAORAL
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyDate = "20261008"
    ds.Modality = "IO"
    ds.Manufacturer = "DEMO Odentia32"
    ds.PatientName = "DEMO^PACIENTE"
    ds.ImagerPixelSpacing = [0.1, 0.1]
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows, ds.Columns = HEIGHT, WIDTH
    if len(frames) > 1:
        ds.NumberOfFrames = len(frames)
    if bits == 8:
        ds.BitsAllocated, ds.BitsStored, ds.HighBit = 8, 8, 7
        data = np.stack([np.round(f.astype(np.float64) * 255 / 4095).astype(np.uint8) for f in frames])
        ds.WindowCenter, ds.WindowWidth = 128, 256
    else:
        ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 12, 11
        data = np.stack(frames)
        ds.WindowCenter, ds.WindowWidth = 2048, 4096
    ds.PixelRepresentation = 0
    ds.PixelData = data.tobytes()
    return ds


def save(ds: Dataset, name: str) -> Path:
    path = OUT / name
    ds.save_as(path, enforce_file_format=True)
    return path


def transcode(src: Path, name: str, syntax, lossy: dict | None = None) -> None:
    """Cambia la sintaxis con GDCM; `lossy` ajusta el códec con pérdida."""
    reader = gdcm.ImageReader()
    reader.SetFileName(str(src))
    if not reader.Read():
        raise SystemExit(f"GDCM no leyó {src}")
    change = gdcm.ImageChangeTransferSyntax()
    change.SetTransferSyntax(gdcm.TransferSyntax(syntax))
    change.SetInput(reader.GetImage())
    if lossy is not None:
        if "jpeg" in lossy:
            codec = gdcm.JPEGCodec()
            codec.SetLossless(False)
            codec.SetQuality(lossy["jpeg"])
            change.SetUserCodec(codec)
        if "jpegls" in lossy:
            codec = gdcm.JPEGLSCodec()
            codec.SetLossless(False)
            codec.SetLossyError(lossy["jpegls"])
            change.SetUserCodec(codec)
    if not change.Change():
        raise SystemExit(f"GDCM no pudo generar {name}")
    writer = gdcm.ImageWriter()
    writer.SetFileName(str(OUT / name))
    writer.SetFile(reader.GetFile())
    writer.SetImage(change.GetOutput())
    if not writer.Write():
        raise SystemExit(f"GDCM no escribió {name}")


TS = gdcm.TransferSyntax
base = save(dataset([drawing(0)]), "explicit-le.dcm")
base8 = save(dataset([drawing(0)], bits=8), "_base-8bit.dcm")
transcode(base, "explicit-be.dcm", TS.ExplicitVRBigEndian)
transcode(base8, "jpeg-baseline.dcm", TS.JPEGBaselineProcess1, {"jpeg": 95})
transcode(base, "jpeg-lossless.dcm", TS.JPEGLosslessProcess14)
transcode(base, "jpeg-lossless-sv1.dcm", TS.JPEGLosslessProcess14_1)
transcode(base, "jpeg-ls-lossless.dcm", TS.JPEGLSLossless)
transcode(base, "jpeg-ls-near-lossless.dcm", TS.JPEGLSNearLossless, {"jpegls": 2})
transcode(base, "rle.dcm", TS.RLELossless)
(OUT / "_base-8bit.dcm").unlink()

for uid, name, extra in (
    (JPEG2000Lossless, "jpeg2000-lossless.dcm", {}),
    (JPEG2000, "jpeg2000.dcm", {"j2k_cr": [12]}),
):
    ds = dataset([drawing(0)])
    ds.compress(uid, encoding_plugin="pylibjpeg", **extra)
    save(ds, name)

# JPEG de 12 bits (Process 4). GDCM 3.2.6 lo escribe con precisión 16, que no
# es válida en JPEG con pérdida; libjpeg-turbo (vía imagecodecs) sí lo hace bien.
ext = dataset([drawing(0)])
ext.PixelData = encapsulate([imagecodecs.jpeg8_encode(drawing(0), level=95, bitspersample=12)])
ext["PixelData"].VR = "OB"
ext["PixelData"].is_undefined_length = True
ext.file_meta.TransferSyntaxUID = JPEGExtended12Bit
ext.LossyImageCompression = "01"
save(ext, "jpeg-extended-12bit.dcm")

# Varios cuadros encapsulados, uno por fragmento y con tabla de desplazamientos.
# GDCM 3.2.6 se cae al codificar multicuadro en JPEG-LS, así que va en RLE.
multi = dataset([drawing(v) for v in range(3)])
multi.compress(RLELossless, encoding_plugin="pydicom")
save(multi, "rle-multiframe.dcm")

for path in sorted(OUT.glob("*.dcm")):
    print(f"{path.name:28} {path.stat().st_size:>7} B")
