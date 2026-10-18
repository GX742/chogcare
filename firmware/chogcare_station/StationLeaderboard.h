#pragma once
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include "StationProtocol.h"

// A single 8 KB thumbnail in RAM. No image decoder, URL, filesystem or network.
// Incomplete/stale transfers never become visible and never touch the LED/EEPROM.
class StationLeaderboard {
 public:
  static constexpr uint16_t SIZE = 64, PIXELS = SIZE * SIZE;
  static constexpr uint32_t SHOW_MS = 8000;
  char id[25] = {}, nick[97] = {}, amount[111] = {}, rank[3] = {};
  uint16_t pixels[PIXELS] = {};
  bool image = false;

  void begin(const StationProtocol::Command &command) {
    clear(); copy(id, command.id); copy(nick, command.nick);
    copy(amount, command.amount); copy(rank, command.rank);
    image = command.image; staging = true;
  }
  bool append(const StationProtocol::Command &command) {
    if (!staging || !image || strcmp(id, command.id)) return false;
    const uint16_t offset = uint16_t(atoi(command.offset));
    const uint16_t count = strlen(command.data) / 4;
    if (offset > received || offset + count > PIXELS) return false;
    if (offset < received) {
      if (offset + count != received) return false;
      for (uint16_t i = 0; i < count; ++i) if (pixels[offset + i] != word(command.data + i * 4)) return false;
      return true; // An identical chunk retry after a lost acknowledgement.
    }
    for (uint16_t i = 0; i < count; ++i) pixels[offset + i] = word(command.data + i * 4);
    received += count; return true;
  }
  bool show(const char *identity, uint32_t now) {
    if (strcmp(id, identity)) return false;
    if (showing) return true; // Retrying a lost shown ACK does not extend the scene.
    if (!staging || received != (image ? PIXELS : 0)) return false;
    staging = false; showing = true; shownAt = now; return true;
  }
  bool visible(uint32_t now) const { return showing && now - shownAt < SHOW_MS; }
  bool expire(uint32_t now) {
    if (!showing || visible(now)) return false;
    showing = false; return true;
  }
  void clear() { staging = showing = false; received = 0; id[0] = '\0'; }
  uint16_t offset() const { return received; }
  uint32_t age(uint32_t now) const { return now - shownAt; }

 private:
  bool staging = false, showing = false;
  uint16_t received = 0;
  uint32_t shownAt = 0;
  template<size_t N> static void copy(char (&target)[N], const char *value) {
    const size_t length = strlen(value); const size_t count = length < N - 1 ? length : N - 1;
    memcpy(target, value, count); target[count] = '\0';
  }
  static uint8_t nibble(char c) { return c <= '9' ? c - '0' : c - 'a' + 10; }
  static uint16_t word(const char *p) {
    return (uint16_t(nibble(p[0])) << 12) | (uint16_t(nibble(p[1])) << 8) |
           (uint16_t(nibble(p[2])) << 4) | nibble(p[3]);
  }
};
