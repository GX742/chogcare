// ChogCare • NodeMCU 1.0 (ESP-12E) • ST7789 240 × 320, portrait.
// TFT RST -> D1; the single external LED -> D0 via 1 kOhm. Other SPI wires stay.
#include "StationApplication.h"

StationApplication station;

void setup() {
  station.begin();
}

void loop() {
  station.tick();
}
