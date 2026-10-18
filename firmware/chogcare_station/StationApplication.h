#pragma once
#include <Arduino.h>
#include <EEPROM.h>
#include <ESP8266WiFi.h>
#include "StationConfig.h"
#include "StationDisplay.h"
#include "StationProtocol.h"

class StationApplication {
 public:
  void begin() {
    pinMode(StationConfig::LED_PIN, OUTPUT);
    digitalWrite(StationConfig::LED_PIN, LOW);
    analogWriteRange(255);
    analogWriteFreq(1000);
    WiFi.persistent(false);
    WiFi.mode(WIFI_OFF);
    WiFi.forceSleepBegin();
    Serial.setRxBufferSize(512);
    Serial.begin(StationConfig::SERIAL_BAUD);
    EEPROM.begin(64);
    memoryReady = EEPROM.length() == 64 && EEPROM.getConstDataPtr() != nullptr;
    if (memoryReady) loadLastDone();
    displayReady = display.begin();
    Serial.print(F("{\"v\":1,\"type\":\"hello\",\"scenes\":2,\"idle\":1,\"last\":\""));
    Serial.print(lastDone);
    Serial.println(F("\"}"));
    if (!displayReady || !memoryReady) Serial.println(F("{\"v\":1,\"type\":\"fault\"}"));
  }

  void tick() {
    readSerial();
    const uint32_t now = millis();
    if (displayReady) display.setConnected(heardBridge && now - lastPingAt < StationConfig::HEARTBEAT_TIMEOUT_MS, broadcastLive);
    if (active) {
      const uint32_t age = now - startedAt;
      if (age >= StationConfig::SHOW_MS) {
        analogWrite(StationConfig::LED_PIN, 0);
        // Completed ID survives USB reconnect/reboot. A power loss mid-show can
        // replay that one unfinished celebration; it can never resend funds.
        if (now - lastPersistAt >= 5000) {
          lastPersistAt = now;
          if (persistLastDone(current.id)) {
            ack(current.id, "done");
            active = false;
            display.idle();
          } else Serial.println(F("{\"v\":1,\"type\":\"fault\"}"));
        }
      } else {
        const float in = smooth(age / float(StationConfig::FADE_IN_MS));
        const float out = smooth((StationConfig::SHOW_MS - age) / float(StationConfig::FADE_OUT_MS));
        // One physical single-color LED: soft arrival, steady gift, then a
        // double heartbeat. No RGB claims, flashing or blocking delays.
        const uint32_t thanksAt = StationConfig::PHOTO_MS + StationConfig::AMOUNT_MS;
        const float phase = (age % 1800) / 1800.0f;
        const float heart = expf(-powf((phase - 0.20f) / 0.09f, 2)) +
                            0.7f * expf(-powf((phase - 0.43f) / 0.09f, 2));
        const float breath = age < thanksAt ? 160 + 35 * sinf(age * TWO_PI / 2400.0f) : 110 + 120 * heart;
        analogWrite(StationConfig::LED_PIN, lroundf(in * out * breath));
      }
    } else analogWrite(StationConfig::LED_PIN, 0);
    if (displayReady) display.animate(now);
    yield();
  }

 private:
  struct Saved { uint32_t magic; char id[25]; uint32_t checksum; };
  static constexpr uint32_t MAGIC = 0x43484f47;
  StationDisplay display;
  StationProtocol::Command current;
  char line[StationConfig::LINE_BYTES + 1] = {}, lastDone[25] = {};
  uint16_t used = 0;
  bool discard = false, active = false, displayReady = false, memoryReady = false, heardBridge = false, broadcastLive = false;
  uint32_t startedAt = 0, lastPingAt = 0, lastPersistAt = 0;

  static float smooth(float x) { x = constrain(x, 0.0f, 1.0f); return x * x * (3 - 2 * x); }
  static uint32_t checksum(const char *id) {
    uint32_t hash = 2166136261UL;
    for (uint8_t i = 0; i < 24; ++i) { hash ^= static_cast<uint8_t>(id[i]); hash *= 16777619UL; }
    return hash;
  }
  void loadLastDone() {
    Saved saved; EEPROM.get(0, saved); saved.id[24] = '\0';
    if (saved.magic == MAGIC && StationProtocol::validId(saved.id) && saved.checksum == checksum(saved.id))
      strlcpy(lastDone, saved.id, sizeof(lastDone));
  }
  bool persistLastDone(const char *id) {
    if (!memoryReady) return false;
    if (!strcmp(lastDone, id)) return true;
    Saved saved = {}; saved.magic = MAGIC;
    strlcpy(saved.id, id, sizeof(saved.id)); saved.checksum = checksum(id);
    EEPROM.put(0, saved);
    if (!EEPROM.commit()) return false;
    strlcpy(lastDone, id, sizeof(lastDone));
    return true;
  }
  void ack(const char *id, const char *status) {
    Serial.print(F("{\"v\":1,\"type\":\"ack\",\"id\":\""));
    Serial.print(id); Serial.print(F("\",\"status\":\""));
    Serial.print(status); Serial.println(F("\"}"));
  }
  void command(const StationProtocol::Command &next) {
    heardBridge = true; lastPingAt = millis();
    if (next.type == StationProtocol::Type::Ping) {
      broadcastLive = next.live;
      Serial.println(F("{\"v\":1,\"type\":\"pong\",\"scenes\":2,\"idle\":1}"));
      return;
    }
    if (!displayReady || !memoryReady) return;
    if (!strcmp(lastDone, next.id)) { ack(next.id, "done"); return; }
    if (active) {
      if (!strcmp(current.id, next.id)) ack(next.id, "accepted");
      // The PC owns the durable queue. An unrelated event cannot interrupt one.
      return;
    }
    current = next; active = true; startedAt = millis();
    display.show(current.nick, current.amount, current.cause, current.test, startedAt);
    ack(current.id, "accepted");
  }
  void readSerial() {
    uint16_t budget = 512;
    while (budget-- && Serial.available()) {
      const char value = static_cast<char>(Serial.read());
      if (value == '\n') {
        if (!discard && used) {
          line[used] = '\0';
          StationProtocol::Command next;
          if (StationProtocol::Parser(line).decode(next)) command(next);
        }
        used = 0; discard = false;
      } else if (value == '\0' || used >= StationConfig::LINE_BYTES) {
        discard = true;
      } else if (!discard) line[used++] = value;
    }
  }
};
