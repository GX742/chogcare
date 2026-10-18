// Portable execution of the actual protocol/staging headers and application
// dispatch. The Node test only removes hardware includes from the application;
// display, serial, EEPROM and GPIO below are observable hardware substitutes.
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>
#include <algorithm>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
#include "StationProtocol.h"
#include "StationLeaderboard.h"

static void expect(bool value, const char *message) {
  if (!value) throw std::runtime_error(message);
}
static StationProtocol::Command decode(const std::string &line) {
  StationProtocol::Command command;
  expect(StationProtocol::Parser(line.c_str()).decode(command), "valid command rejected");
  return command;
}
static const char *ID = "000000000000000000000001";
static const char *OTHER = "000000000000000000000002";
static std::string boardLine(const char *id = ID, bool image = true) {
  return std::string("{\"v\":1,\"type\":\"board\",\"id\":\"") + id +
    "\",\"nick\":\"GX\",\"amount\":\"1,800\",\"rank\":\"2\",\"image\":" + (image ? "true}" : "false}");
}
static uint16_t pixelValue(unsigned pixel) { return uint16_t(pixel * 31u + 0x1234u); }
static std::string pixelsLine(unsigned offset, unsigned count = 64, const char *id = ID) {
  const char *hex = "0123456789abcdef";
  std::string data;
  for (unsigned index = offset; index < offset + count; ++index) {
    const uint16_t value = pixelValue(index);
    for (int shift = 12; shift >= 0; shift -= 4) data += hex[(value >> shift) & 15];
  }
  return std::string("{\"v\":1,\"type\":\"pixels\",\"id\":\"") + id +
    "\",\"offset\":\"" + std::to_string(offset) + "\",\"data\":\"" + data + "\"}";
}
static std::string showLine(const char *id = ID) {
  return std::string("{\"v\":1,\"type\":\"boardshow\",\"id\":\"") + id + "\"}";
}

static void parserChecks() {
  using namespace StationProtocol;
  expect(decode(boardLine()).type == Type::Board, "board type");
  expect(decode(pixelsLine(4032)).type == Type::Pixels, "pixels type");
  expect(decode(showLine()).type == Type::BoardShow, "commit type");
  expect(decode("{\"v\":1,\"type\":\"boardclear\"}").type == Type::BoardClear, "clear type");
  const std::vector<std::string> invalid = {
    boardLine().substr(0, boardLine().size() - 1) + ",\"live\":true}",
    boardLine().substr(0, boardLine().size() - 1) + ",\"image\":true}",
    "{\"v\":1,\"type\":\"board\",\"id\":\"000000000000000000000001\",\"nick\":\"GX\",\"amount\":\"1\",\"image\":false}",
    "{\"v\":1,\"type\":\"boardclear\",\"id\":\"000000000000000000000001\"}",
    showLine() + "garbage", "{\"v\":1,\"type\":\"boardshow\",\"id\":\"ABCDEF000000000000000001\"}",
    "{\"v\":1,\"type\":\"pixels\",\"id\":\"000000000000000000000001\",\"offset\":\"064\",\"data\":\"1234\"}",
    "{\"v\":1,\"type\":\"pixels\",\"id\":\"000000000000000000000001\",\"offset\":\"4097\",\"data\":\"1234\"}",
    "{\"v\":1,\"type\":\"pixels\",\"id\":\"000000000000000000000001\",\"offset\":\"0\",\"data\":\"12FF\"}",
    "{\"v\":1,\"type\":\"pixels\",\"id\":\"000000000000000000000001\",\"offset\":\"0\",\"data\":\"123\"}",
    "{\"v\":1,\"type\":\"pixels\",\"id\":\"000000000000000000000001\",\"offset\":\"0\",\"data\":\"" + std::string(260, 'a') + "\"}",
    "{\"v\":1,\"type\":\"board\",\"id\":\"000000000000000000000001\",\"nick\":\"" + std::string(25, 'a') + "\",\"amount\":\"1\",\"rank\":\"1\",\"image\":false}",
    "{\"v\":1,\"type\":\"board\",\"id\":\"000000000000000000000001\",\"nick\":\"GX\",\"amount\":\"" + std::string(111, '1') + "\",\"rank\":\"1\",\"image\":false}",
    "{\"v\":1,\"type\":\"board\",\"id\":\"000000000000000000000001\",\"nick\":\"\\u0047X\",\"amount\":\"1\",\"rank\":\"1\",\"image\":false}"
  };
  for (const std::string &line : invalid) {
    Command sentinel; strcpy(sentinel.id, OTHER); sentinel.type = Type::Donation;
    expect(!Parser(line.c_str()).decode(sentinel), "malformed command accepted");
    expect(!strcmp(sentinel.id, OTHER) && sentinel.type == Type::Donation, "failed parse mutated output");
  }
  for (const char *amount : {"1", "1,800", "3,000.25", "0.01", "<0.01", "1.1"})
    expect(validBoardAmount(amount), "display amount rejected");
  for (const char *amount : {"0", "0.00", "01", "01.25", "1,80", "1,0000", "1,000,00", "1.001", "-1", "1 CHOG", "1e3", "1\n"})
    expect(!validBoardAmount(amount), "invalid display amount accepted");
  for (const char *rank : {"0", "01", "21", "-1"}) {
    std::string line = boardLine(); const size_t at = line.find("\"rank\":\"2\"");
    line.replace(at, strlen("\"rank\":\"2\""), std::string("\"rank\":\"") + rank + "\"");
    Command command; expect(!Parser(line.c_str()).decode(command), "invalid rank accepted");
  }
  expect(validNickname("\xd0\x93\xd0\xbe\xd1\x81\xd1\x82\xd1\x8c GX"), "Cyrillic nickname rejected");
  expect(!validNickname("\xc0\xaf") && !validNickname("\xed\xa0\x80") && !validNickname("GX\n"), "invalid UTF-8/control accepted");
  std::cout << "parser bounds and failed-parse isolation passed\n";
}

static void stagingChecks() {
  StationLeaderboard board;
  static_assert(sizeof(board.pixels) == 8192, "one 64x64 RGB565 thumbnail");
  static_assert(sizeof(StationLeaderboard) < 8500, "bounded thumbnail state");
  static_assert(sizeof(StationProtocol::Command) < 600, "bounded protocol command");
  board.begin(decode(boardLine()));
  expect(!board.show(ID, 100), "partial image became visible");
  expect(!board.append(decode(pixelsLine(64))), "future chunk accepted");
  expect(!board.append(decode(pixelsLine(0, 64, OTHER))), "foreign chunk accepted");
  for (unsigned offset = 0; offset < 4096; offset += 64) {
    const auto chunk = decode(pixelsLine(offset));
    expect(board.append(chunk), "ordered chunk rejected");
    expect(board.offset() == offset + 64, "incorrect next offset");
    expect(!board.visible(100), "staging image became visible");
    expect(board.append(chunk) && board.offset() == offset + 64, "identical retry not idempotent");
    auto corrupt = chunk; corrupt.data[0] = corrupt.data[0] == 'a' ? 'b' : 'a';
    expect(!board.append(corrupt), "changed retry accepted");
    if (offset >= 64) expect(!board.append(decode(pixelsLine(offset - 64))), "old chunk accepted");
  }
  for (unsigned index = 0; index < 4096; ++index) expect(board.pixels[index] == pixelValue(index), "RGB565 pixel/order corruption");
  expect(!board.append(decode(pixelsLine(4096, 1))), "thumbnail overflow accepted");
  expect(!board.show(OTHER, 100), "foreign commit accepted");
  expect(board.show(ID, 100) && board.visible(100), "complete image not shown");
  expect(board.show(ID, 7999), "duplicate commit not acknowledged");
  expect(board.age(8100) == 8000 && !board.visible(8100), "retry extended display lifetime");
  expect(!board.expire(8099) && board.expire(8100) && !board.expire(8101), "expiry boundary/idempotency");
  expect(!board.show(ID, 8200), "expired scene revived by late commit");
  board.begin(decode(boardLine(OTHER, false)));
  expect(board.offset() == 0 && !board.append(decode(pixelsLine(0, 1, OTHER))), "fallback accepted pixels");
  const uint32_t beforeWrap = UINT32_MAX - 3999u;
  expect(board.show(OTHER, beforeWrap), "fallback not shown");
  expect(board.visible(uint32_t(beforeWrap + 7999u)), "millis wrap ended display early");
  expect(!board.visible(uint32_t(beforeWrap + 8000u)) && board.expire(uint32_t(beforeWrap + 8000u)), "millis wrap bypassed expiry");
  board.begin(decode(boardLine())); board.append(decode(pixelsLine(0))); board.clear();
  expect(board.offset() == 0 && !board.append(decode(pixelsLine(64))) && !board.show(ID, 0), "clear allowed stale upload/commit");
  std::cout << "4096 pixels, ordering, retry, commit, expiry and wraparound passed\n";
}

// Observable substitutes for the physical dependencies. The application body
// and constants included below are read from the production headers by Node.
constexpr uint8_t D0 = 16, D1 = 5, D2 = 4, D4 = 2, D5 = 14, D7 = 13;
constexpr int OUTPUT = 1, LOW = 0, WIFI_OFF = 0;
constexpr float TWO_PI = 6.2831853071795864769f;
#define F(value) value
static uint32_t clockNow = 10000;
static int ledValue = 0;
static std::vector<int> ledWrites;
static uint32_t millis() { return clockNow; }
static void pinMode(uint8_t, int) {}
static void digitalWrite(uint8_t, int value) { ledValue = value; ledWrites.push_back(value); }
static void analogWrite(uint8_t, int value) { ledValue = value; ledWrites.push_back(value); }
static void analogWriteRange(int) {}
static void analogWriteFreq(int) {}
static void yield() {}
template<typename T> static T constrain(T value, T low, T high) { return std::max(low, std::min(value, high)); }
static size_t strlcpy(char *target, const char *value, size_t size) {
  const size_t length = strlen(value);
  if (size) { const size_t count = std::min(length, size - 1); memcpy(target, value, count); target[count] = '\0'; }
  return length;
}
struct FakeSerial {
  std::string input, output; size_t position = 0;
  void setRxBufferSize(unsigned) {} void begin(unsigned) {}
  unsigned available() const { return unsigned(input.size() - position); }
  int read() { return input[position++]; }
  void print(const char *value) { output += value; }
  void print(char *value) { output += value; }
  template<typename T> void print(T value) { output += std::to_string(value); }
  void println(const char *value) { output += value; output += '\n'; }
  void inject(const std::string &value) { input += value; }
} Serial;
struct FakeEEPROM {
  unsigned commits = 0; uint8_t bytes[64] = {};
  void begin(unsigned) {} unsigned length() const { return sizeof(bytes); }
  const uint8_t *getConstDataPtr() const { return bytes; }
  template<typename T> void get(unsigned offset, T &value) { expect(offset + sizeof(value) <= sizeof(bytes), "EEPROM read bounds"); memcpy(&value, bytes + offset, sizeof(value)); }
  template<typename T> void put(unsigned offset, const T &value) { expect(offset + sizeof(value) <= sizeof(bytes), "EEPROM write bounds"); memcpy(bytes + offset, &value, sizeof(value)); }
  bool commit() { ++commits; return true; }
} EEPROM;
struct FakeWiFi { void persistent(bool) {} void mode(int) {} void forceSleepBegin() {} } WiFi;
#include "station-config-under-test.h"
class StationDisplay {
 public:
  static StationDisplay *latest;
  StationLeaderboard board; unsigned donationShows = 0;
  StationDisplay() { latest = this; }
  bool begin() { return true; }
  void setConnected(bool, bool) {}
  void beginBoard(const StationProtocol::Command &command) { board.begin(command); }
  bool boardPixels(const StationProtocol::Command &command) { return board.append(command); }
  uint16_t boardOffset() const { return board.offset(); }
  bool showBoard(const char *id, uint32_t now) { return board.show(id, now); }
  void clearBoard() { board.clear(); }
  void show(const char *, const char *, const char *, bool, uint32_t) { board.clear(); ++donationShows; }
  void idle() {}
  void animate(uint32_t now) { board.expire(now); }
};
StationDisplay *StationDisplay::latest = nullptr;
#include "station-application-under-test.h"

static void send(StationApplication &application, const std::string &line) {
  Serial.output.clear(); Serial.inject(line + '\n');
  while (Serial.available()) application.tick();
}
static void applicationChecks() {
  StationApplication application; application.begin();
  expect(Serial.output.find("\"board\":1") != std::string::npos, "capability not advertised");
  send(application, boardLine(ID, false));
  expect(Serial.output.find("\"type\":\"boardack\"") != std::string::npos && Serial.output.find("\"status\":\"ready\"") != std::string::npos, "begin ACK channel");
  send(application, showLine());
  expect(StationDisplay::latest->board.visible(clockNow) && ledValue == 0 && EEPROM.commits == 0, "leaderboard activated LED/persistence");
  for (int value : ledWrites) expect(value == 0, "leaderboard emitted nonzero LED");
  send(application, boardLine(OTHER)); // Incomplete image must yield to donation.
  send(application, pixelsLine(0, 64, OTHER));
  const std::string donation = std::string("{\"v\":1,\"type\":\"donation\",\"id\":\"") + ID + "\",\"nick\":\"GX\",\"amount\":\"300\",\"cause\":\"school-supplies\"}";
  send(application, donation);
  expect(StationDisplay::latest->donationShows == 1 && !StationDisplay::latest->board.visible(clockNow), "donation did not preempt board");
  expect(Serial.output.find("\"type\":\"ack\"") != std::string::npos && Serial.output.find("accepted") != std::string::npos, "donation ACK missing");
  clockNow += 1000; application.tick(); expect(ledValue > 0, "real donation LED did not light");
  send(application, boardLine(OTHER, false)); expect(Serial.output.empty(), "board interrupted active donation");
  send(application, showLine(OTHER)); expect(Serial.output.empty(), "stale commit interrupted donation");
  send(application, donation); expect(StationDisplay::latest->donationShows == 1, "duplicate donation restarted scene");
  clockNow += StationConfig::SHOW_MS; application.tick();
  expect(ledValue == 0 && EEPROM.commits == 1 && Serial.output.find("\"status\":\"done\"") != std::string::npos, "donation completion/persistence");
  send(application, showLine(OTHER)); expect(Serial.output.empty(), "canceled image revived after gratitude");
  send(application, boardLine(OTHER, false)); send(application, showLine(OTHER));
  expect(StationDisplay::latest->board.visible(clockNow) && ledValue == 0 && EEPROM.commits == 1, "idle board affected completed donation");
  StationApplication rebooted; rebooted.begin(); send(rebooted, donation);
  expect(StationDisplay::latest->donationShows == 0 && Serial.output.find("\"status\":\"done\"") != std::string::npos && ledValue == 0 && EEPROM.commits == 1, "board changed durable donation replay protection");
  send(rebooted, std::string(385, 'a')); expect(Serial.output.empty(), "oversize line accepted");
  send(rebooted, "{\"v\":1,\"type\":\"ping\",\"live\":true}");
  expect(Serial.output.find("\"type\":\"pong\"") != std::string::npos, "oversize line poisoned following command");
  std::cout << "actual application dispatch, LED, priority, replay and serial bounds passed\n";
}

static void hostWireChecks(const char *path) {
  std::ifstream input(path); expect(bool(input), "host transcript missing");
  StationLeaderboard board; std::string line; unsigned chunks = 0, commands = 0;
  while (std::getline(input, line)) {
    expect(line.size() + 1 <= 384, "host line exceeds serial limit");
    const auto command = decode(line); ++commands;
    if (command.type == StationProtocol::Type::Board) board.begin(command);
    else if (command.type == StationProtocol::Type::Pixels) { expect(board.append(command), "actual host chunk rejected"); ++chunks; }
    else if (command.type == StationProtocol::Type::BoardShow) expect(board.show(command.id, 100), "actual host commit rejected");
    else expect(false, "unexpected host command");
  }
  expect(commands == 66 && chunks == 64 && board.offset() == 4096 && board.visible(100), "host transcript incomplete");
  for (unsigned index = 0; index < 4096; ++index) expect(board.pixels[index] == pixelValue(index), "host/MCU RGB565 mismatch");
  std::cout << "actual JavaScript transport transcript parsed and staged passed\n";
}
int main(int argc, char **argv) {
  try {
    expect(argc == 2, "host transcript argument required");
    parserChecks(); stagingChecks(); applicationChecks(); hostWireChecks(argv[1]);
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
