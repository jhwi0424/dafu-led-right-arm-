# 大符右灯臂

nRF52840 通过 `P0.09` 驱动 54 颗 WS2812。灯珠的 3.3 V 和 GND 并联，数据由首颗 DIN 沿灯链逐颗串联。开机以蓝通道 `B=4` 点亮，网页可调范围为 `B=0–8`。

## 网页调光

```powershell
python -m http.server 8771 --bind 127.0.0.1 --directory frontend
```

用桌面版 Chrome 或 Edge 打开 [右灯臂调光台](http://127.0.0.1:8771/)，点击「连接串口」，选择 `LED54 Right Arm`。页面显示固件确认的亮度、数据时序、帧数、运行时间、控制器 VDD 和芯片温度。连接方式和串口协议见 [调光台说明](frontend/README.md)。

## 固件

| 模式 | UF2 | 串口 DFU 包 |
| --- | --- | --- |
| 网页调光与实时回报 | [led54_control.uf2](led54_control.uf2) | [led54_control_dfu.zip](firmware/led54_control_dfu.zip) |
| 固定低亮度蓝光 | [led54_blue.uf2](led54_blue.uf2) | [led54_blue_dfu.zip](firmware/led54_blue_dfu.zip) |

在 nRF52840 的 UF2 bootloader 模式下复制对应文件，板子刷入后会自动重启。两版固件均面向现有 S140 6.1.1 启动环境。

## 构建调光固件

`python build.py <工具目录>` 会从 [led54_blue.cpp](led54_blue.cpp) 生成 `led54_control.uf2`。工具目录应包含 `arm-gcc`、`cmsis` 和 `nrf52-core-openssl`，目录中的 Adafruit nRF52 Arduino 核心使用 PCA10056 变体。台架构建使用 Adafruit nRF52 Arduino 核心 1.7.0（`ba4ad90`）和 Arm GNU 工具链 9-2019-q4。省略目录参数时，脚本默认使用上一级目录中的 `nrf52840 J/.tools`。
