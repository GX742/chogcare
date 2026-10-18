#pragma once
#include <Arduino.h>

namespace StationConfig {
constexpr uint8_t TFT_CS = D4;
constexpr uint8_t TFT_DC = D2;
constexpr uint8_t TFT_RST = D1;  // Move only the TFT reset wire from D0 to D1.
constexpr uint8_t LED_PIN = D0;  // GPIO16 -> 1 kOhm -> LED anode; cathode -> GND.
// Hardware SPI: SCLK D5 / GPIO14; MOSI D7 / GPIO13. BL and VCC -> 3V3.
constexpr uint8_t ROTATION = 0;
constexpr uint32_t SPI_HZ = 20000000;
constexpr uint32_t SERIAL_BAUD = 115200;
constexpr uint32_t PHOTO_MS = 6000;
constexpr uint32_t AMOUNT_MS = 4500;
constexpr uint32_t THANKS_MS = 4500;
constexpr uint32_t SHOW_MS = PHOTO_MS + AMOUNT_MS + THANKS_MS;
constexpr uint32_t FADE_IN_MS = 450;
constexpr uint32_t FADE_OUT_MS = 800;
constexpr uint32_t HEARTBEAT_TIMEOUT_MS = 12000;
constexpr uint32_t FRAME_MS = 50; // Target 20 fps; coin sparkles + overflowing text only.
constexpr uint16_t LINE_BYTES = 384;
constexpr uint16_t STRIP_HEIGHT = 32; // 15 KB, not a 153 KB full framebuffer.
}
