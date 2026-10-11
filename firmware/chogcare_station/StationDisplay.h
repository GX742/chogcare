#pragma once
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <U8g2_for_Adafruit_GFX.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSansBold24pt7b.h>
#include <math.h>
#include "StationConfig.h"
#include "StationArt.h"

// A band compositor writes finished pixels straight to the TFT. No fillScreen
// between frames and no full-sized RGB framebuffer on the ESP8266.
class StationDisplay {
 public:
  StationDisplay() : tft(StationConfig::TFT_CS, StationConfig::TFT_DC,
                         StationConfig::TFT_RST), band(240, StationConfig::STRIP_HEIGHT) {}

  bool begin() {
    if (!band.getBuffer()) return false;
    tft.init(240, 320);
    tft.setRotation(StationConfig::ROTATION);
    tft.setSPISpeed(StationConfig::SPI_HZ);
    tft.setTextWrap(false);
    type.begin(band);
    type.setFontMode(1);
    type.setFontDirection(0);
    amount[0] = nick[0] = '\0';
    renderFull();
    return true;
  }

  void setConnected(bool value) {
    if (connected == value) return;
    connected = value;
    renderBand(0);
  }

  void show(const char *nickname, const char *chog, uint32_t now) {
    strlcpy(nick, nickname, sizeof(nick));
    formatAmount(chog);
    prepareTypography();
    active = true;
    startedAt = now;
    frameAt = now;
    renderFull();
  }

  void idle() {
    active = false;
    renderFull();
  }

  void animate(uint32_t now) {
    const uint32_t elapsed = now - frameAt;
    if (elapsed < StationConfig::FRAME_MS) return;
    frameAt = now;
    // Keep phases small for continuous 24/7 operation. Converting the total
    // uptime to float loses animation precision after long uptimes.
    orbitPhase = fmodf(orbitPhase + min(elapsed, uint32_t(1000)) * 0.00028f, TWO_PI);
    age = active ? now - startedAt : 0;
    // Redraw each moving strip once. Overflowing names/amounts move in the
    // original large font; short text remains steady, not repeatedly resized.
    for (int16_t y = 0; y < 320; y += StationConfig::STRIP_HEIGHT) {
      const bool movingArt = active ? y >= 96 && y <= 192 : y >= 64 && y <= 192;
      const bool movingName = active && nicknameWidth > TEXT_WIDTH && y >= 64 && y <= 96;
      const bool movingAmount = active && amountWidth > TEXT_WIDTH && y >= 192 && y <= 256;
      if (movingArt || movingName || movingAmount) renderBand(y);
    }
  }

 private:
  static constexpr int16_t TEXT_LEFT = 12, TEXT_WIDTH = 216;
  Adafruit_ST7789 tft;
  GFXcanvas16 band;
  U8G2_FOR_ADAFRUIT_GFX type;
  bool active = false, connected = false;
  uint32_t startedAt = 0, frameAt = 0, age = 0;
  float orbitPhase = 0;
  int16_t bandY = 0;
  int16_t nicknameWidth = 0, amountWidth = 0, amountBearing = 0;
  const GFXfont *amountFont = &FreeSansBold24pt7b;
  uint8_t amountScale = 1;
  char nick[97] = {}, amount[32] = {};

  static uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) {
    return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
  }
  static float ease(float x) { x = constrain(x, 0.0f, 1.0f); return x * x * (3 - 2 * x); }
  static uint16_t background() { return rgb(15, 5, 25); }
  bool intersects(int16_t top, int16_t bottom) const {
    return bandY < bottom && bandY + StationConfig::STRIP_HEIGHT > top;
  }
  void line(int16_t x1, int16_t y1, int16_t x2, int16_t y2, uint16_t color) {
    band.drawLine(x1, y1 - bandY, x2, y2 - bandY, color);
  }
  void dot(int16_t x, int16_t y, int16_t radius, uint16_t color) {
    band.fillCircle(x, y - bandY, radius, color);
  }
  void text(const char *value, const uint8_t *font, int16_t x, int16_t baseline, uint16_t color) {
    type.setFont(font);
    type.setForegroundColor(color);
    type.setCursor(x, baseline - bandY);
    type.print(value);
    // One-pixel overstrike makes the Cyrillic strokes survive webcam scaling.
    type.setCursor(x + 1, baseline - bandY);
    type.print(value);
  }
  int16_t textX(int16_t width) const {
    if (width <= TEXT_WIDTH) return (240 - width) / 2;
    // A full pass within the 20-second show, with time to read both ends.
    // age is wrap-safe and identical for every strip in the current frame.
    const uint32_t travel = age > 1500 ? min(age - 1500, uint32_t(16000)) : 0;
    const int16_t offset = lroundf((width - TEXT_WIDTH) * ease(travel / 16000.0f));
    return TEXT_LEFT - offset;
  }
  void maskTextMargins(int16_t top, int16_t bottom) {
    band.fillRect(0, top - bandY, TEXT_LEFT, bottom - top, background());
    band.fillRect(240 - TEXT_LEFT, top - bandY, TEXT_LEFT, bottom - top, background());
  }
  void prepareTypography() {
    type.setFont(u8g2_font_inr24_t_cyrillic);
    nicknameWidth = type.getUTF8Width(nick) + 1;
    int16_t x, y; uint16_t width, height;
    amountFont = &FreeSansBold24pt7b;
    amountScale = 1;
    band.setFont(amountFont);
    band.setTextSize(amountScale);
    band.getTextBounds(amount, 0, 0, &x, &y, &width, &height);
    // Precise long values scroll at this same moderate size, without rounding.
    amountWidth = width; amountBearing = x;
    band.setTextSize(1);
    band.setFont(nullptr);
  }
  void gfxCenter(const char *value, const GFXfont *font, int16_t baseline, uint16_t color) {
    int16_t x, y; uint16_t width, height;
    band.setFont(font);
    band.setTextSize(1);
    band.getTextBounds(value, 0, 0, &x, &y, &width, &height);
    band.setTextColor(color);
    band.setCursor((240 - width) / 2 - x, baseline - bandY);
    band.print(value);
    band.setFont(nullptr);
  }
  void charityRoute(int16_t baseline, uint16_t ink, uint16_t accent) {
    int16_t x, y; uint16_t leftWidth, rightWidth, height;
    band.setFont(&FreeSansBold12pt7b);
    band.setTextSize(1);
    band.getTextBounds("CHOG", 0, 0, &x, &y, &leftWidth, &height);
    const int16_t leftBearing = x;
    band.getTextBounds("CHARITY", 0, 0, &x, &y, &rightWidth, &height);
    const int16_t rightBearing = x;
    const int16_t start = (240 - leftWidth - rightWidth - 40) / 2;
    band.setTextColor(ink);
    band.setCursor(start - leftBearing, baseline - bandY);
    band.print("CHOG");
    const int16_t arrowX = start + leftWidth + 8, arrowY = baseline - 8;
    line(arrowX, arrowY, arrowX + 23, arrowY, accent);
    line(arrowX + 18, arrowY - 5, arrowX + 23, arrowY, accent);
    line(arrowX + 18, arrowY + 5, arrowX + 23, arrowY, accent);
    band.setTextColor(accent);
    band.setCursor(arrowX + 32 - rightBearing, baseline - bandY);
    band.print("CHARITY");
    band.setFont(nullptr);
  }
  void coin(const uint16_t *pixels, int16_t size, int16_t left, int16_t top) {
    // Clip before drawing: only the rows in this 32px band are read from flash.
    // Keep the const pointer: Adafruit_GFX's PROGMEM overload uses pgm_read_word.
    const int16_t first = max(top, bandY);
    const int16_t last = min(int16_t(top + size), int16_t(bandY + StationConfig::STRIP_HEIGHT));
    if (first >= last) return;
    band.drawRGBBitmap(left, first - bandY, pixels + (first - top) * size, size, last - first);
  }
  void renderFull() {
    age = 0;
    for (int16_t y = 0; y < 320; y += StationConfig::STRIP_HEIGHT) {
      renderBand(y);
      yield();
    }
  }
  void renderBand(int16_t y) {
    bandY = y;
    // Compose finished pixels offscreen; no physical fillScreen between frames.
    band.fillScreen(background());
    const uint16_t ink = rgb(255, 255, 255), pink = rgb(255, 163, 229);
    if (intersects(0, 10)) dot(232, 6, 3, connected ? rgb(133, 255, 205) : rgb(91, 58, 111));
    if (active) {
      if (intersects(0, 56)) gfxCenter("Thank you", &FreeSansBold18pt7b, 46, pink);
      if (intersects(64, 112)) {
        text(nick, u8g2_font_inr24_t_cyrillic, textX(nicknameWidth), 96, ink);
        maskTextMargins(64, 112);
      }
      if (intersects(112, 208)) {
        coin(StationArt::DonationCoin, StationArt::DonationCoinSize, 72, 112);
        for (uint8_t i = 0; i < 4; ++i) {
          const float a = orbitPhase + i * TWO_PI / 4;
          // Stay beside the image and clear of the name and amount slots.
          const int16_t dx = lroundf(cosf(a) * 58), dy = lroundf(sinf(a) * 42);
          if (abs(dx) >= 51) dot(120 + dx, 160 + dy, 2, pink);
        }
      }
      if (intersects(208, 272)) { drawAmount(254, ink); maskTextMargins(208, 272); }
      if (intersects(272, 308)) gfxCenter("CHOG", &FreeSansBold12pt7b, 291, pink);
    } else {
      if (intersects(0, 56)) gfxCenter("ChogCare", &FreeSansBold18pt7b, 46, ink);
      if (intersects(72, 224)) {
        coin(StationArt::IdleCoin, StationArt::IdleCoinSize, 56, 84);
        for (uint8_t i = 0; i < 2; ++i) {
          const float a = orbitPhase + i * PI;
          const int16_t dx = lroundf(cosf(a) * 75), dy = lroundf(sinf(a) * 70);
          if (abs(dx) >= 68 || abs(dy) >= 68) dot(120 + dx, 148 + dy, 2, pink);
        }
      }
      if (intersects(248, 296)) charityRoute(275, ink, pink);
    }
    tft.drawRGBBitmap(0, y, band.getBuffer(), 240, StationConfig::STRIP_HEIGHT);
    yield();
  }
  void formatAmount(const char *value) {
    const char *decimal = strchr(value, '.');
    const size_t whole = decimal ? static_cast<size_t>(decimal - value) : strlen(value);
    uint8_t at = 0;
    for (size_t i = 0; i < whole; ++i) {
      amount[at++] = value[i];
      if (i + 1 < whole && (whole - i - 1) % 3 == 0) amount[at++] = ',';
    }
    if (decimal) {
      const size_t fraction = strlen(decimal);
      memcpy(amount + at, decimal, fraction);
      at += fraction;
    }
    amount[at] = '\0';
  }
  void drawAmount(int16_t baseline, uint16_t color) {
    band.setFont(amountFont);
    band.setTextSize(amountScale);
    band.setTextWrap(false);
    band.setTextColor(color);
    band.setCursor(textX(amountWidth) - amountBearing, baseline - bandY);
    band.print(amount);
    band.setTextSize(1);
    band.setFont(nullptr);
  }
};
