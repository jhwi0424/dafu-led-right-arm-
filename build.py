"""Build a UF2 for the existing nRF52840 S140 6.1.1 bootloader."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import sys


root = Path(__file__).resolve().parent
tools = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root.parent / "nrf52840 J" / ".tools"
core = tools / "nrf52-core-openssl"
base = core / "cores/nRF5"
variant = core / "variants/pca10056"
tinyusb = core / "libraries/Adafruit_TinyUSB_Arduino/src"
spi = core / "libraries/SPI"
sdk = base / "nordic"
rtos = base / "freertos"
out = root / "build"
out.mkdir(parents=True, exist_ok=True)
firmware = "led54_control"

gcc = next((tools / "arm-gcc").rglob("arm-none-eabi-gcc.exe"))
cmsis = next((tools / "cmsis").rglob("core_cm4.h")).parent
dsp = next((tools / "cmsis").rglob("arm_math.h")).parent
includes = [
    base, variant, cmsis, dsp, sdk, sdk / "nrfx", sdk / "nrfx/hal", sdk / "nrfx/mdk",
    sdk / "nrfx/soc", sdk / "nrfx/drivers/include", sdk / "nrfx/drivers/src",
    sdk / "softdevice/s140_nrf52_6.1.1_API/include",
    sdk / "softdevice/s140_nrf52_6.1.1_API/include/nrf52",
    rtos / "Source/include", rtos / "config", rtos / "portable/GCC/nrf52",
    rtos / "portable/CMSIS/nrf52", base / "sysview/SEGGER", base / "sysview/Config",
    tinyusb, tinyusb / "arduino", spi,
]
definitions = [
    "F_CPU=64000000", "ARDUINO=10819", "ARDUINO_ARCH_NRF52", "ARDUINO_NRF52840_PCA10056",
    'ARDUINO_BSP_VERSION="1.7.0"', "SOFTDEVICE_PRESENT", "ARDUINO_NRF52_ADAFRUIT",
    "NRF52_SERIES", "NRF52840_XXAA", "DX_CC_TEE", "CFG_DEBUG=0", "CFG_LOGGER=0",
    "CFG_SYSVIEW=0", "USBCON", "USE_TINYUSB", "USB_VID=0x239A", "USB_PID=0x80DA",
    'USB_MANUFACTURER="nRF52840"', 'USB_PRODUCT="LED54 Right Arm"',
    "CONFIG_NFCT_PINS_AS_GPIOS",
]
arch = ["-mcpu=cortex-m4", "-mthumb", "-mfloat-abi=hard", "-mfpu=fpv4-sp-d16"]
common = arch + ["-Os", "-ffunction-sections", "-fdata-sections"]
common += [f"-D{item}" for item in definitions] + [f"-I{path}" for path in includes]
sources = [root / "led54_blue.cpp"]
for directory in (base, variant, tinyusb, spi):
    sources.extend(path for path in sorted(directory.rglob("*")) if path.suffix in (".c", ".cpp", ".S"))


def compile_source(index_and_source):
    index, source = index_and_source
    obj = out / f"{index}.o"
    if source.suffix == ".cpp":
        compiler = gcc.with_name("arm-none-eabi-g++.exe")
        flags = ["-std=gnu++11", "-fno-threadsafe-statics", "-fno-rtti", "-fno-exceptions"]
    else:
        compiler = gcc
        flags = ["-std=gnu11"] if source.suffix == ".c" else ["-x", "assembler-with-cpp"]
    subprocess.run([str(compiler), *common, *flags, "-c", str(source), "-o", str(obj)], check=True)
    return str(obj)


print(f"Compiling {len(sources)} files", flush=True)
with ThreadPoolExecutor(max_workers=6) as pool:
    objects = list(pool.map(compile_source, enumerate(sources)))

elf = out / f"{firmware}.elf"
link = arch + [
    "-Wl,--gc-sections", "-Wl,--wrap=malloc", "-Wl,--wrap=free", "-Wl,--wrap=realloc",
    "-Wl,--wrap=calloc", "--specs=nano.specs", "--specs=nosys.specs",
    f"-L{base / 'linker'}", f"-T{base / 'linker/nrf52840_s140_v6.ld'}",
    "-o", elf.name, *(Path(obj).name for obj in objects), "-Wl,--start-group", "-lm", "-lc", "-lstdc++", "-lgcc",
    "-Wl,--end-group",
]
response = out / "link.rsp"
response.write_text("\n".join('"' + arg.replace("\\", "/") + '"' for arg in link), encoding="utf-8")
subprocess.run([str(gcc), f"@{response.name}"], cwd=out, check=True)
subprocess.run([str(gcc.with_name("arm-none-eabi-size.exe")), str(elf)], check=True)
hexfile = out / f"{firmware}.hex"
subprocess.run([str(gcc.with_name("arm-none-eabi-objcopy.exe")), "-O", "ihex", str(elf), str(hexfile)], check=True)
subprocess.run([
    sys.executable, str(core / "tools/uf2conv/uf2conv.py"), str(hexfile), "-c", "-f", "0xADA52840",
    "-o", str(root / f"{firmware}.uf2"),
], check=True)
