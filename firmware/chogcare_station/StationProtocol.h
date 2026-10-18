#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace StationProtocol {
enum class Type : uint8_t { Ping, Donation, Board, Pixels, BoardShow, BoardClear };
struct Command {
  Type type = Type::Ping;
  char id[25] = {};
  char nick[97] = {};
  char amount[111] = {};
  char cause[20] = {};
  char rank[3] = {}, offset[5] = {}, data[257] = {};
  bool test = false;
  bool live = false;
  bool image = false;
};

inline bool validId(const char *value) {
  if (strlen(value) != 24) return false;
  for (uint8_t i = 0; i < 24; ++i)
    if (!((value[i] >= '0' && value[i] <= '9') ||
          (value[i] >= 'a' && value[i] <= 'f'))) return false;
  return true;
}

inline bool validAmount(const char *value) {
  uint8_t whole = 0, fraction = 0;
  const char *p = value;
  while (*p >= '0' && *p <= '9') { ++whole; ++p; }
  if (whole < 1 || whole > 7 || (whole > 1 && value[0] == '0')) return false;
  if (*p == '.') {
    ++p;
    while (*p >= '0' && *p <= '9') { ++fraction; ++p; }
    if (fraction < 1 || fraction > 18) return false;
  }
  return *p == '\0';
}

inline bool validNickname(const char *value) {
  const uint8_t *p = reinterpret_cast<const uint8_t *>(value);
  uint8_t count = 0;
  while (*p) {
    uint32_t cp = *p++;
    uint8_t extra = 0;
    if (cp >= 0xc2 && cp <= 0xdf) { cp &= 0x1f; extra = 1; }
    else if (cp >= 0xe0 && cp <= 0xef) { cp &= 0x0f; extra = 2; }
    else if (cp >= 0xf0 && cp <= 0xf4) { cp &= 0x07; extra = 3; }
    else if (cp >= 0x80) return false;
    for (uint8_t i = 0; i < extra; ++i) {
      if (*p < 0x80 || *p > 0xbf) return false;
      cp = (cp << 6) | (*p++ & 0x3f);
    }
    if ((extra == 1 && cp < 0x80) || (extra == 2 && cp < 0x800) ||
        (extra == 3 && cp < 0x10000) || cp > 0x10ffff ||
        (cp >= 0xd800 && cp <= 0xdfff)) return false;
    const bool ascii = (cp >= 'A' && cp <= 'Z') || (cp >= 'a' && cp <= 'z') ||
      (cp >= '0' && cp <= '9') || cp == ' ' || cp == '_' || cp == '-' || cp == '.';
    // The chosen fonts contain ASCII + Cyrillic. The PC transliterates Latin
    // accents before transmission; reject unsupported glyphs here as well.
    const bool alphabet = (cp >= 0x0400 && cp <= 0x052f);
    if (!ascii && !alphabet) return false;
    if (++count > 24) return false;
  }
  return count > 0;
}

inline bool decimalNumber(const char *value, uint16_t maximum) {
  if (!value[0] || (value[0] == '0' && value[1])) return false;
  uint32_t number = 0;
  for (const char *p = value; *p; ++p) {
    if (*p < '0' || *p > '9') return false;
    number = number * 10 + (*p - '0');
    if (number > maximum) return false;
  }
  return true;
}

inline bool validBoardAmount(const char *value) {
  if (!strcmp(value, "<0.01")) return true;
  uint8_t group = 0, fraction = 0;
  bool comma = false, positive = false;
  const char *p = value;
  if (value[0] == '0' && value[1] != '.') return false;
  while (*p && *p != '.') {
    if (*p == ',') {
      if (!group || (!comma && group > 3) || (comma && group != 3)) return false;
      comma = true; group = 0;
    } else {
      if (*p < '0' || *p > '9' || group >= 110) return false;
      positive = positive || *p != '0'; ++group;
    }
    ++p;
  }
  if (!group || (comma && group != 3)) return false;
  if (*p == '.') {
    ++p;
    while (*p >= '0' && *p <= '9') { positive = positive || *p != '0'; ++fraction; ++p; }
    if (!fraction || fraction > 2) return false;
  }
  return !*p && positive;
}

inline bool validPixels(const char *value) {
  const size_t count = strlen(value);
  if (!count || count > 256 || count % 4) return false;
  for (size_t i = 0; i < count; ++i)
    if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
  return true;
}

// The PC emits a tiny flat JSON schema. No dynamic allocation, recursive JSON,
// partial strings or input echo. Unknown/duplicate keys fail closed. Unicode is
// sent as UTF-8; \u escapes are intentionally outside this protocol.
class Parser {
 public:
  explicit Parser(const char *line) : cursor(line) {}
  bool decode(Command &out) {
    Command result;
    char key[12], type[12];
    uint16_t seen = 0;
    if (!take('{')) return false;
    do {
      if (!string(key, sizeof(key)) || !take(':')) return false;
      uint16_t bit = 0;
      if (!strcmp(key, "v")) {
        bit = 1;
        skip();
        if (*cursor++ != '1') return false;
        skip();
        if (*cursor != ',' && *cursor != '}') return false;
      } else if (!strcmp(key, "type")) {
        bit = 2;
        if (!string(type, sizeof(type))) return false;
        if (!strcmp(type, "ping")) result.type = Type::Ping;
        else if (!strcmp(type, "donation")) result.type = Type::Donation;
        else if (!strcmp(type, "board")) result.type = Type::Board;
        else if (!strcmp(type, "pixels")) result.type = Type::Pixels;
        else if (!strcmp(type, "boardshow")) result.type = Type::BoardShow;
        else if (!strcmp(type, "boardclear")) result.type = Type::BoardClear;
        else return false;
      } else if (!strcmp(key, "id")) {
        bit = 4; if (!string(result.id, sizeof(result.id))) return false;
      } else if (!strcmp(key, "nick")) {
        bit = 8; if (!string(result.nick, sizeof(result.nick))) return false;
      } else if (!strcmp(key, "amount")) {
        bit = 16; if (!string(result.amount, sizeof(result.amount))) return false;
      } else if (!strcmp(key, "cause")) {
        bit = 32; if (!string(result.cause, sizeof(result.cause))) return false;
        if (strcmp(result.cause, "school-supplies") && strcmp(result.cause, "vida-verde") &&
            strcmp(result.cause, "solar-foundation") && strcmp(result.cause, "animal-ethics") &&
            strcmp(result.cause, "burundi")) return false;
      } else if (!strcmp(key, "test")) {
        bit = 64; skip();
        if (strncmp(cursor, "true", 4)) return false;
        cursor += 4; result.test = true;
      } else if (!strcmp(key, "live")) {
        bit = 128; skip();
        if (!strncmp(cursor, "true", 4)) { cursor += 4; result.live = true; }
        else if (!strncmp(cursor, "false", 5)) cursor += 5;
        else return false;
      } else if (!strcmp(key, "rank")) {
        bit = 256; if (!string(result.rank, sizeof(result.rank))) return false;
      } else if (!strcmp(key, "image")) {
        bit = 512; skip();
        if (!strncmp(cursor, "true", 4)) { cursor += 4; result.image = true; }
        else if (!strncmp(cursor, "false", 5)) cursor += 5;
        else return false;
      } else if (!strcmp(key, "offset")) {
        bit = 1024; if (!string(result.offset, sizeof(result.offset))) return false;
      } else if (!strcmp(key, "data")) {
        bit = 2048; if (!string(result.data, sizeof(result.data))) return false;
      } else return false;
      if (seen & bit) return false;
      seen |= bit;
      skip();
      if (*cursor != ',') break;
      ++cursor;
    } while (true);
    if (!take('}')) return false;
    skip();
    if (*cursor) return false;
    if (result.type == Type::Ping) {
      if (seen != 3 && seen != 131) return false;
    } else if (result.type == Type::Donation) {
      if ((seen & ~uint16_t(127)) || (seen & 31) != 31 || !validId(result.id) ||
          !validAmount(result.amount) || !validNickname(result.nick)) return false;
    } else if (result.type == Type::Board) {
      if (seen != 799 || !validId(result.id) || !validNickname(result.nick) ||
          !validBoardAmount(result.amount) || !decimalNumber(result.rank, 20) || !strcmp(result.rank, "0")) return false;
    } else if (result.type == Type::Pixels) {
      if (seen != 3079 || !validId(result.id) || !decimalNumber(result.offset, 4096) || !validPixels(result.data)) return false;
    } else if (result.type == Type::BoardShow) {
      if (seen != 7 || !validId(result.id)) return false;
    } else if (seen != 3) return false;
    out = result;
    return true;
  }
 private:
  const char *cursor;
  void skip() { while (*cursor == ' ' || *cursor == '\t' || *cursor == '\r') ++cursor; }
  bool take(char expected) { skip(); if (*cursor != expected) return false; ++cursor; return true; }
  bool string(char *out, size_t capacity) {
    if (!take('"')) return false;
    size_t size = 0;
    while (*cursor && *cursor != '"') {
      uint8_t value = static_cast<uint8_t>(*cursor++);
      if (value == '\\') {
        value = static_cast<uint8_t>(*cursor++);
        if (value != '"' && value != '\\' && value != '/') return false;
      }
      if (value < 0x20 || value == 0x7f || size + 1 >= capacity) return false;
      out[size++] = static_cast<char>(value);
    }
    if (*cursor != '"') return false;
    ++cursor;
    out[size] = '\0';
    return true;
  }
};
}
