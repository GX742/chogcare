#pragma once
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <U8g2_for_Adafruit_GFX.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSansBold24pt7b.h>
#include <math.h>
#include "StationConfig.h"
#include "StationArt.h"
#include "StationBrand.h"
#include "StationLeaderboard.h"

// One 7.5 KB strip, never a full-screen framebuffer. Brand images live in flash;
// only the status line, hearts and overflowing text need animated redraws.
class StationDisplay {
 public:
  StationDisplay() : tft(StationConfig::TFT_CS, StationConfig::TFT_DC,
                         StationConfig::TFT_RST), band(240, StationConfig::STRIP_HEIGHT) {}
  bool begin() {
    if (!band.getBuffer()) return false;
    tft.init(240, 320); tft.setRotation(StationConfig::ROTATION);
    tft.setSPISpeed(StationConfig::SPI_HZ); tft.setTextWrap(false);
    band.setTextWrap(false);
    type.begin(band); type.setFontMode(1); type.setFontDirection(0);
    renderFull(); return true;
  }
  void setConnected(bool value, bool streaming) {
    const bool nextLive = value && streaming;
    if (connected == value && live == nextLive) return;
    connected = value;
    live = nextLive;
    if (!connected && board.visible(frameAt)) { board.clear(); if (!active) renderFull(); return; }
    if (!active) renderStatus();
  }
  void beginBoard(const StationProtocol::Command &command) {
    const bool previous = board.visible(frameAt); board.begin(command);
    if (!active && previous) renderFull();
  }
  bool boardPixels(const StationProtocol::Command &command) { return board.append(command); }
  uint16_t boardOffset() const { return board.offset(); }
  bool showBoard(const char *id, uint32_t now) {
    if (!board.show(id, now)) return false;
    boardNickAscii = true;
    for (const uint8_t *p = reinterpret_cast<const uint8_t *>(board.nick); *p; ++p) if (*p >= 128) boardNickAscii = false;
    int16_t x, y; uint16_t width, height;
    band.setFont(&FreeSansBold18pt7b); band.getTextBounds(board.nick, 0, 0, &x, &y, &width, &height);
    boardNickAscii = boardNickAscii && width <= 216;
    type.setFont(u8g2_font_10x20_t_cyrillic); boardNickWidth = type.getUTF8Width(board.nick) + 1;
    boardAmountFont = &FreeSansBold24pt7b;
    for (uint8_t size = 0; size < 3; ++size) {
      band.setFont(boardAmountFont); band.getTextBounds(board.amount, 0, 0, &x, &y, &width, &height);
      if (width <= 216 || size == 2) break;
      boardAmountFont = size == 0 ? &FreeSansBold18pt7b : &FreeSansBold12pt7b;
    }
    boardAmountWidth = width; boardAmountBearing = x; band.setFont(nullptr);
    frameAt = now; if (!active) renderFull(); return true;
  }
  void clearBoard() { const bool previous = board.visible(frameAt); board.clear(); if (previous && !active) renderFull(); }
  void show(const char *nickname, const char *chog, const char *cause, bool isTest, uint32_t now) {
    board.clear();
    strlcpy(nick, nickname, sizeof(nick)); formatAmount(chog);
    test = isTest || !strcmp(nick, "TEST - NO PAYMENT") || !strcmp(nick, "DEMO");
    setInitiative("A cause", "you chose");
    if (!strcmp(cause, "school-supplies")) setInitiative("School", "Supplies", "& Crypto", "Education");
    else if (!strcmp(cause, "vida-verde")) setInitiative("+Vida", "+Verde", "Venezuela");
    else if (!strcmp(cause, "solar-foundation")) setInitiative("The Solar", "Foundation");
    else if (!strcmp(cause, "animal-ethics")) setInitiative("Animal", "Ethics");
    else if (!strcmp(cause, "burundi")) setInitiative("Perfect", "Villages", "Burundi");
    type.setFont(u8g2_font_10x20_t_cyrillic); nicknameWidth = type.getUTF8Width(nick) + 1;
    int16_t x, y; uint16_t w, h;
    band.setFont(&FreeSansBold24pt7b); band.getTextBounds(amount, 0, 0, &x, &y, &w, &h);
    amountWidth = w; amountBearing = x; band.setFont(nullptr);
    active = true; startedAt = frameAt = now; age = 0; lastScene = 0;
    renderFull();
  }
  void idle() { active = false; age = 0; renderFull(); }
  void animate(uint32_t now) {
    const uint32_t elapsed = now - frameAt;
    if (elapsed < StationConfig::FRAME_MS) return;
    frameAt = now;
    if (!active && board.expire(now)) renderFull();
    orbitPhase = fmodf(orbitPhase + min(elapsed, uint32_t(1000)) * 0.0018f, TWO_PI);
    age = active ? now - startedAt : 0;
    const uint8_t current = scene();
    const bool full = active && current != lastScene;
    for (int16_t y = 0; y < 320; y += StationConfig::STRIP_HEIGHT) {
      const bool moving = active ?
        (y >= 288 || (current == 1 && amountWidth > 216 && y >= 160 && y <= 224) ||
         (current == 2 && y >= 64 && y <= 160) ||
         (current == 2 && nicknameWidth > 216 && y >= 224 && y <= 256)) :
        (y >= 288 || (board.visible(now) && ((!boardNickAscii && boardNickWidth > 216 && y >= 192 && y <= 224) ||
          (boardAmountWidth > 216 && y >= 224 && y <= 256))));
      if (full || moving) renderBand(y);
    }
    lastScene = current;
  }

 private:
  Adafruit_ST7789 tft;
  GFXcanvas16 band;
  U8G2_FOR_ADAFRUIT_GFX type;
  StationLeaderboard board;
  bool boardNickAscii = false;
  int16_t boardNickWidth = 0, boardAmountWidth = 0, boardAmountBearing = 0;
  const GFXfont *boardAmountFont = &FreeSansBold24pt7b;
  bool active = false, connected = false, live = false, test = false;
  uint32_t startedAt = 0, frameAt = 0, age = 0;
  uint8_t lastScene = 0;
  float orbitPhase = 0;
  int16_t bandY = 0, nicknameWidth = 0, amountWidth = 0, amountBearing = 0;
  char nick[97] = {}, amount[32] = {};
  const char *titleLines[4] = {"", "", "", ""};
  int16_t titleBaselines[4] = {};
  uint8_t titleLineCount = 0;
  static uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) { return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3); }
  static uint16_t background() { return rgb(15, 5, 25); }
  static uint16_t ink() { return rgb(252, 247, 255); }
  static uint16_t pink() { return rgb(255, 163, 215); }
  static uint16_t muted() { return rgb(181, 165, 203); }
  static float ease(float x) { x = constrain(x, 0.0f, 1.0f); return x * x * (3 - 2 * x); }
  uint8_t scene() const { return age < StationConfig::PHOTO_MS ? 0 : age < StationConfig::PHOTO_MS + StationConfig::AMOUNT_MS ? 1 : 2; }
  uint32_t sceneAge() const { return age - (scene() == 0 ? 0 : scene() == 1 ? StationConfig::PHOTO_MS : StationConfig::PHOTO_MS + StationConfig::AMOUNT_MS); }
  uint32_t sceneDuration() const { return scene() == 0 ? StationConfig::PHOTO_MS : scene() == 1 ? StationConfig::AMOUNT_MS : StationConfig::THANKS_MS; }
  bool intersects(int16_t top, int16_t bottom) const { return bandY < bottom && bandY + StationConfig::STRIP_HEIGHT > top; }
  void line(int16_t x1, int16_t y1, int16_t x2, int16_t y2, uint16_t color) { band.drawLine(x1, y1 - bandY, x2, y2 - bandY, color); }
  void dot(int16_t x, int16_t y, int16_t radius, uint16_t color) { band.fillCircle(x, y - bandY, radius, color); }
  void small(const char *value, int16_t x, int16_t baseline, uint16_t color) {
    type.setFont(u8g2_font_6x12_tf); type.setForegroundColor(color);
    type.setCursor(x, baseline - bandY); type.print(value);
  }
  void smallCenter(const char *value, int16_t baseline, uint16_t color) {
    type.setFont(u8g2_font_6x12_tf); small(value, (240 - type.getUTF8Width(value)) / 2, baseline, color);
  }
  void readable(const char *value, int16_t x, int16_t baseline, uint16_t color) {
    type.setFont(u8g2_font_helvB08_tf); type.setForegroundColor(color);
    type.setCursor(x, baseline - bandY); type.print(value);
  }
  void gfxCenter(const char *value, const GFXfont *font, int16_t baseline, uint16_t color, int16_t center = 120) {
    int16_t x, y; uint16_t w, h;
    band.setFont(font); band.setTextSize(1); band.getTextBounds(value, 0, 0, &x, &y, &w, &h);
    band.setTextColor(color); band.setCursor(center - (w + 1) / 2 - x, baseline - bandY); band.print(value); band.setFont(nullptr);
  }
  void setInitiative(const char *first, const char *second = "", const char *third = "", const char *fourth = "") {
    titleLines[0] = first; titleLines[1] = second; titleLines[2] = third; titleLines[3] = fourth;
    titleLineCount = 4;
    while (titleLineCount && !titleLines[titleLineCount - 1][0]) --titleLineCount;
    // Use actual glyph bounds: descenders in Supplies / Crypto need more room
    // than a line of capitals. Center the complete title without shrinking it.
    int16_t tops[4]; uint16_t heights[4]; int16_t totalHeight = 0;
    for (uint8_t i = 0; i < titleLineCount; ++i) {
      int16_t x; uint16_t w;
      band.setFont(initiativeFont(titleLines[i]));
      band.getTextBounds(titleLines[i], 0, 0, &x, &tops[i], &w, &heights[i]);
      totalHeight += heights[i] + (i ? 5 : 0);
    }
    int16_t top = 100 + (172 - totalHeight) / 2;
    for (uint8_t i = 0; i < titleLineCount; ++i) {
      titleBaselines[i] = top - tops[i]; top += heights[i] + 5;
    }
    band.setFont(nullptr);
  }
  const GFXfont *initiativeFont(const char *value) {
    int16_t x, y; uint16_t w, h;
    band.setFont(&FreeSansBold24pt7b); band.getTextBounds(value, 0, 0, &x, &y, &w, &h);
    return w <= 216 ? &FreeSansBold24pt7b : &FreeSansBold18pt7b;
  }
  void initiativeTitle(const char *value, int16_t baseline, uint16_t color) {
    if (value[0]) gfxCenter(value, initiativeFont(value), baseline, color);
  }
  int16_t textX(int16_t width) const {
    if (width <= 216) return (240 - width) / 2;
    const uint32_t local = sceneAge();
    const float progress = local <= 650 ? 0 : min(local - 650, uint32_t(3200)) / 3200.0f;
    return 12 - lroundf((width - 216) * ease(progress));
  }
  void mask(int16_t top, int16_t height) {
    band.fillRect(0, top - bandY, 12, height, background());
    band.fillRect(228, top - bandY, 12, height, background());
  }
  void coin(const uint16_t *pixels, int16_t size, int16_t left, int16_t top) {
    const int16_t first = max(top, bandY), last = min(int16_t(top + size), int16_t(bandY + StationConfig::STRIP_HEIGHT));
    if (first < last) band.drawRGBBitmap(left, first - bandY, pixels + (first - top) * size, size, last - first);
  }
  void heart(int16_t x, int16_t y, int16_t size) {
    dot(x - size / 2, y, size / 2, pink()); dot(x + size / 2, y, size / 2, pink());
    band.fillTriangle(x - size, y - bandY, x + size, y - bandY, x, y + size - bandY, pink());
  }
  void liveLine() {
    type.setFont(u8g2_font_helvB10_tf);
    const uint8_t glow = 140 + lroundf(55 * (sinf(orbitPhase * 2) + 1));
    const uint16_t color = live ? rgb(110, glow, 174) : connected ? pink() : muted();
    const char *label = live ? "LIVE" : connected ? "STATION ONLINE" : "CONNECTING";
    const int16_t labelWidth = type.getUTF8Width(label);
    const int16_t width = 16 + labelWidth;
    const int16_t left = (240 - width) / 2;
    dot(left + 4, 301, 4, color);
    type.setForegroundColor(color); type.setCursor(left + 16, 307 - bandY); type.print(label);
  }
  void chrome() {
    for (uint8_t i = 0; i < 3; ++i) band.fillRoundRect(12 + i * 74, 6 - bandY, 68, 3, 1, i == scene() ? pink() : rgb(55, 34, 76));
    const char *label = scene() == 0 ? "YOUR IMPACT" : scene() == 1 ? "YOUR DONATION" : "WITH GRATITUDE";
    if (scene() == 0) {
      readable(label, 12, 30, muted());
      if (test) small("TEST / NO PAYMENT", 132, 29, pink());
    } else {
      small(label, 12, 29, muted());
      if (test) small("TEST / NO PAYMENT", 132, 29, pink());
    }
    if (intersects(314, 320)) {
      band.fillRect(12, 315 - bandY, 216, 2, rgb(55, 34, 76));
      band.fillRect(12, 315 - bandY, min(uint32_t(216), age * 216 / StationConfig::SHOW_MS), 2, pink());
    }
  }
  int16_t boardTextX(int16_t width) const {
    if (width <= 216) return (240 - width) / 2;
    const uint32_t local = board.age(frameAt);
    const float progress = local <= 650 ? 0 : min(local - 650, uint32_t(6000)) / 6000.0f;
    return 12 - lroundf((width - 216) * ease(progress));
  }
  void boardAvatar() {
    const int16_t left = 56, top = 60, size = 128, radius = 15;
    const int16_t first = max(top, bandY), last = min(int16_t(top + size), int16_t(bandY + StationConfig::STRIP_HEIGHT));
    for (int16_t y = first; y < last; ++y) for (int16_t x = 0; x < size; ++x) {
      const int16_t edgeX = min(x, int16_t(size - 1 - x)), edgeY = min(int16_t(y - top), int16_t(top + size - 1 - y));
      if (edgeX < radius && edgeY < radius && (radius - edgeX) * (radius - edgeX) + (radius - edgeY) * (radius - edgeY) > radius * radius) continue;
      uint16_t color;
      if (board.image) color = board.pixels[((y - top) / 2) * StationLeaderboard::SIZE + x / 2];
      else color = pgm_read_word(StationArt::DonationCoin + ((y - top) * 96 / size) * 96 + x * 96 / size);
      band.drawPixel(left + x, y - bandY, color);
    }
  }
  void renderBoard() {
    if (intersects(0, 36)) gfxCenter("LEADERBOARD", &FreeSansBold12pt7b, 30, ink());
    if (intersects(40, 54)) {
      line(12, 45, 75, 45, rgb(55, 34, 76)); line(165, 45, 228, 45, rgb(55, 34, 76));
      char rank[10]; snprintf(rank, sizeof(rank), "TOP %02u", unsigned(atoi(board.rank)));
      smallCenter(rank, 49, pink());
    }
    if (intersects(56, 192)) { band.drawRoundRect(52, 56 - bandY, 136, 136, 19, rgb(106, 57, 138)); boardAvatar(); }
    if (intersects(196, 226)) {
      if (boardNickAscii) gfxCenter(board.nick, &FreeSansBold18pt7b, 223, ink());
      else { type.setFont(u8g2_font_10x20_t_cyrillic); type.setForegroundColor(ink()); type.setCursor(boardTextX(boardNickWidth), 220 - bandY); type.print(board.nick); mask(196, 30); }
    }
    if (intersects(230, 272)) {
      band.setFont(boardAmountFont); band.setTextColor(pink()); band.setCursor(boardTextX(boardAmountWidth) - boardAmountBearing, 263 - bandY); band.print(board.amount); band.setFont(nullptr); mask(230, 42);
    }
    if (intersects(274, 290)) smallCenter("CHOG DONATED", 287, muted());
    if (intersects(288, 320)) liveLine();
  }
  void renderFull() {
    for (int16_t y = 0; y < 320; y += StationConfig::STRIP_HEIGHT) { renderBand(y); yield(); }
  }
  void renderStatus() {
    for (int16_t y = 288; y < 320; y += StationConfig::STRIP_HEIGHT) renderBand(y);
  }
  void renderBand(int16_t y) {
    bandY = y; band.fillScreen(background());
    if (!active) {
      if (board.visible(frameAt)) { renderBoard(); tft.drawRGBBitmap(0, y, band.getBuffer(), 240, StationConfig::STRIP_HEIGHT); yield(); return; }
      if (intersects(0, 48)) gfxCenter("ChogCare", &FreeSansBold18pt7b, 35, ink());
      if (intersects(54, 230)) coin(StationBrand::WaitingArt, 176, 32, 54);
      if (intersects(232, 282)) { gfxCenter("Waiting for", &FreeSansBold12pt7b, 254, ink()); gfxCenter("kindness", &FreeSansBold12pt7b, 279, pink()); }
      if (intersects(288, 320)) liveLine();
    } else {
      if (scene() == 0) {
        if (intersects(50, 86)) {
          band.fillRoundRect(12, 50 - bandY, 216, 36, 18, rgb(39, 20, 53));
          for (uint8_t stroke = 0; stroke < 2; ++stroke) {
            line(29, 65 + stroke, 35, 71 + stroke, pink());
            line(35, 71 + stroke, 46, 60 + stroke, pink());
          }
          gfxCenter("Kindness received", &FreeSansBold9pt7b, 73, ink(), 133);
        }
        if (intersects(100, 272)) {
          for (uint8_t i = 0; i < titleLineCount; ++i) {
            initiativeTitle(titleLines[i], titleBaselines[i], i + 1 == titleLineCount ? pink() : ink());
          }
        }
        if (intersects(280, 288)) line(84, 284, 156, 284, pink());
      } else if (scene() == 1) {
        if (intersects(48, 144)) coin(StationArt::DonationCoin, 96, 72, 48);
        if (intersects(156, 216)) {
          band.setFont(&FreeSansBold24pt7b); band.setTextColor(ink()); band.setCursor(textX(amountWidth) - amountBearing, 205 - bandY); band.print(amount); band.setFont(nullptr); mask(156, 60);
        }
        if (intersects(220, 312)) {
          gfxCenter("CHOG", &FreeSansBold12pt7b, 237, pink());
          smallCenter("Original donation amount", 263, muted());
          smallCenter(test ? "SIMULATED - NO FUNDS MOVED" : "Cause delivery confirmed", 290, ink());
        }
      } else {
        if (intersects(48, 176)) coin(StationBrand::ThanksArt, 128, 56, 48);
        if (intersects(64, 164)) { const int16_t size = 5 + lroundf(2 * (sinf(orbitPhase * 2) + 1)); heart(32, 108, size); heart(208, 108, size); }
        if (intersects(184, 220)) gfxCenter("Thank you!", &FreeSansBold18pt7b, 214, pink());
        if (intersects(224, 264)) {
          if (test) gfxCenter("CHOG FRIEND", &FreeSansBold12pt7b, 253, ink());
          else { type.setFont(u8g2_font_10x20_t_cyrillic); type.setForegroundColor(ink()); type.setCursor(textX(nicknameWidth), 253 - bandY); type.print(nick); mask(224, 40); }
        }
        if (intersects(272, 312)) { smallCenter("You made a difference.", 283, ink()); smallCenter(test ? "SCREEN PREVIEW ONLY" : "Real people. Real care.", 304, muted()); }
      }
      chrome();
    }
    tft.drawRGBBitmap(0, y, band.getBuffer(), 240, StationConfig::STRIP_HEIGHT); yield();
  }
  void formatAmount(const char *value) {
    const char *decimal = strchr(value, '.');
    const size_t whole = decimal ? static_cast<size_t>(decimal - value) : strlen(value);
    uint8_t at = 0;
    for (size_t i = 0; i < whole; ++i) { amount[at++] = value[i]; if (i + 1 < whole && (whole - i - 1) % 3 == 0) amount[at++] = ','; }
    if (decimal) { const size_t fraction = strlen(decimal); memcpy(amount + at, decimal, fraction); at += fraction; }
    amount[at] = '\0';
  }
};
