#include <Arduino.h>
#include <nrf.h>
#include <cstdio>
#include <cstring>

namespace {
constexpr unsigned kDataPin = 9;  // P0.09 on the MCU
constexpr unsigned kPixels = 54;
constexpr uint8_t kBootBlue = 4;
constexpr uint8_t kMaxBlue = 8;
constexpr unsigned kRefreshMs = 250;
constexpr unsigned kSensorMs = 500;
constexpr unsigned kTimeoutMs = 2000;
constexpr uint16_t kLow = 0x8000;
constexpr uint16_t kZero = kLow | 5;
constexpr uint16_t kOne = kLow | 10;
constexpr unsigned kLatchPeriods = 321;
constexpr unsigned kPixelBits = kPixels * 24;
constexpr unsigned kFrameWords = kPixelBits + kLatchPeriods;
constexpr uint32_t kDisconnected = PWM_PSEL_OUT_CONNECT_Msk;

alignas(4) uint16_t frame[kFrameWords];
const char *status = "STARTING";
const char *fault = nullptr;
const char *stopReason = "BOOT";
int appliedBlue = -1;
uint32_t lastControl = 0;
uint32_t lastFrame = 0;
unsigned long frameCount = 0;
uint32_t lastSensor = 0;
unsigned vddMv = 0;
int tempCentiC = 0;
bool controlled = false;
char command[24];
size_t commandLength = 0;
bool discardCommand = false;
char reply[512];
size_t replyLength = 0;
size_t replyOffset = 0;

void configurePwm() {
  NRF_P0->OUTCLR = 1UL << kDataPin;
  NRF_P0->DIRSET = 1UL << kDataPin;
  NRF_PWM0->ENABLE = 0;
  for (auto &output : NRF_PWM0->PSEL.OUT) {
    output = kDisconnected;
  }
  NRF_PWM0->MODE = PWM_MODE_UPDOWN_Up;
  NRF_PWM0->PRESCALER = PWM_PRESCALER_PRESCALER_DIV_1;
  NRF_PWM0->COUNTERTOP = 20;  // 1.25 us per bit
  NRF_PWM0->DECODER = PWM_DECODER_LOAD_Common;
  NRF_PWM0->LOOP = 0;
  NRF_PWM0->SHORTS = 0;
  NRF_PWM0->SEQ[0].PTR = reinterpret_cast<uint32_t>(frame);
  NRF_PWM0->SEQ[0].CNT = kFrameWords;
  NRF_PWM0->SEQ[0].REFRESH = 0;
  NRF_PWM0->SEQ[0].ENDDELAY = 0;
}

void fillFrame(uint8_t blue) {
  const uint8_t grb[] = {0, 0, blue};
  auto *word = frame;
  for (unsigned pixel = 0; pixel < kPixels; ++pixel) {
    for (const uint8_t channel : grb) {
      for (unsigned mask = 0x80; mask != 0; mask >>= 1) {
        *word++ = channel & mask ? kOne : kZero;
      }
    }
  }
  while (word != frame + kFrameWords) {
    *word++ = kLow;
  }
}

bool waitFor(volatile uint32_t &event, uint32_t timeoutMs) {
  const uint32_t start = millis();
  while (!event) {
    if (millis() - start >= timeoutMs) {
      return false;
    }
    delay(1);
  }
  return true;
}

const char *show() {
  NRF_PWM0->EVENTS_SEQEND[0] = 0;
  NRF_PWM0->EVENTS_STOPPED = 0;
  NRF_PWM0->PSEL.OUT[0] = kDataPin;
  NRF_PWM0->ENABLE = PWM_ENABLE_ENABLE_Enabled;
  __DMB();
  NRF_PWM0->TASKS_SEQSTART[0] = 1;
  // At SEQEND, the final low sample starts after 320 complete low periods.
  const bool completed = waitFor(NRF_PWM0->EVENTS_SEQEND[0], 30);
  NRF_PWM0->TASKS_STOP = 1;
  const bool stopped = waitFor(NRF_PWM0->EVENTS_STOPPED, 10);
  if (stopped) {
    NRF_PWM0->ENABLE = 0;
  }
  NRF_PWM0->PSEL.OUT[0] = kDisconnected;
  if (!stopped) {
    return "STOP_TIMEOUT";
  }
  return completed ? nullptr : "FRAME_TIMEOUT";
}

bool sendFrame(uint8_t blue) {
  fillFrame(blue);
  fault = show();
  lastFrame = millis();
  if (!fault) {
    ++frameCount;
    appliedBlue = blue;
    status = "PWM_DONE";
    return true;
  }

  appliedBlue = -1;
  controlled = false;
  status = fault;
  stopReason = "FAULT";
  // Only reuse the DMA buffer if the PWM peripheral confirmed it stopped.
  if (strcmp(fault, "FRAME_TIMEOUT") == 0) {
    fillFrame(0);
    if (!show()) {
      lastFrame = millis();
      ++frameCount;
      appliedBlue = 0;
    }
  }
  return false;
}

void turnOff(const char *reason) {
  controlled = false;
  stopReason = reason;
  if (appliedBlue != 0) {
    sendFrame(0);
  }
}

void sampleSensors() {
  // The internal 0.6 V reference and 1/6 gain give a 3.6 V full scale.
  vddMv = (analogReadVDD() * 3600 + 2048) / 4096;
  tempCentiC = int(readCPUTemperature() * 100);
  lastSensor = millis();
}

void queueReply(const char *result, bool legacy = false) {
  const uint32_t now = millis();
  int written;
  if (legacy) {
    written = snprintf(reply, sizeof(reply), "%s PIXELS=%u P0.09 GRB B=%d\r\n",
                       status, kPixels, appliedBlue);
  } else {
    written = snprintf(reply, sizeof(reply),
                       "{\"protocol\":\"LED54/1\",\"board\":\"right-arm\",\"result\":\"%s\",\"state\":\"%s\","
                       "\"blue\":%d,\"maxBlue\":%u,\"pixels\":%u,\"pin\":\"P0.%02u\","
                       "\"order\":\"GRB\",\"bitRate\":800000,\"zeroDuty\":25,\"oneDuty\":50,"
                       "\"latchUs\":400,\"frameBits\":%u,\"refreshMs\":%u,\"timeoutMs\":%u,"
                       "\"uptimeMs\":%lu,\"stopReason\":\"%s\",\"bootBlue\":%u,\"controlled\":%s,"
                       "\"frameCount\":%lu,\"frameAgeMs\":%lu,\"vddMv\":%u,\"tempCentiC\":%d}\n",
                       result, status, appliedBlue, unsigned(kMaxBlue), kPixels,
                       kDataPin, kPixelBits, kRefreshMs, kTimeoutMs, static_cast<unsigned long>(now),
                       stopReason, unsigned(kBootBlue), controlled ? "true" : "false", frameCount,
                       static_cast<unsigned long>(frameCount ? now - lastFrame : 0), vddMv, tempCentiC);
  }
  replyOffset = 0;
  replyLength = written > 0 && size_t(written) < sizeof(reply) ? size_t(written) : 0;
}

const char *setBlue(const char *digits) {
  if (*digits == '\0') {
    return "BAD_COMMAND";
  }
  unsigned blue = 0;
  for (const char *digit = digits; *digit; ++digit) {
    if (*digit < '0' || *digit > '9') {
      return "BAD_COMMAND";
    }
    if (blue <= kMaxBlue) {
      blue = blue * 10 + unsigned(*digit - '0');
    }
  }
  if (blue > kMaxBlue) {
    return "LIMIT";
  }
  if (fault || (int(blue) != appliedBlue && !sendFrame(uint8_t(blue)))) {
    return "FAULT";
  }
  controlled = blue != 0;
  stopReason = blue == 0 ? "USER" : "NONE";
  lastControl = millis();
  return "OK";
}

const char *runCommand(const char *line) {
  if (strcmp(line, "GET") == 0) {
    return "OK";
  }
  if (strcmp(line, "KEEP") == 0) {
    if (controlled) {
      lastControl = millis();
    }
    return "OK";
  }
  if (strncmp(line, "SET ", 4) == 0) {
    return setBlue(line + 4);
  }
  return "BAD_COMMAND";
}

void pollSerial() {
  if (replyOffset < replyLength) {
    const size_t available = Serial.availableForWrite();
    const size_t remaining = replyLength - replyOffset;
    if (available) {
      replyOffset += Serial.write(reinterpret_cast<const uint8_t *>(reply + replyOffset),
                                  available < remaining ? available : remaining);
      Serial.flush();
    }
    return;
  }
  for (unsigned budget = 0; budget < 64 && Serial.available(); ++budget) {
    const int byte = Serial.read();
    if (byte == '?' && commandLength == 0 && !discardCommand) {
      queueReply("OK", true);
      return;
    }
    if (byte == '\n') {
      if (commandLength && command[commandLength - 1] == '\r') {
        --commandLength;
      }
      command[commandLength] = '\0';
      queueReply(discardCommand ? "BAD_COMMAND" : runCommand(command));
      commandLength = 0;
      discardCommand = false;
      return;
    }
    if ((byte == '\r' || (byte >= 32 && byte <= 126)) && commandLength < sizeof(command) - 1) {
      command[commandLength++] = char(byte);
    } else {
      discardCommand = true;
    }
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  analogReference(AR_INTERNAL);
  analogReadResolution(12);
  analogOversampling(8);
  sampleSensors();
  if ((NRF_UICR->NFCPINS & UICR_NFCPINS_PROTECT_Msk) != 0) {
    fault = status = "NFC_PINS_NOT_GPIO";
    stopReason = "FAULT";
    return;
  }
  configurePwm();
  delay(100);
  if (sendFrame(0)) {
    sendFrame(kBootBlue);
  }
}

void loop() {
  if (millis() - lastSensor >= kSensorMs) {
    sampleSensors();
  }
  const bool connected = static_cast<bool>(Serial);
  if (!connected) {
    commandLength = replyLength = replyOffset = 0;
    discardCommand = false;
    for (unsigned budget = 0; budget < 64 && Serial.available(); ++budget) {
      Serial.read();
    }
  }
  if (controlled) {
    if (!connected) {
      turnOff("USB_LOST");
    } else if (millis() - lastControl >= kTimeoutMs) {
      turnOff("TIMEOUT");
    }
  }
  if (connected) {
    pollSerial();
  }
  if (!fault && millis() - lastFrame >= kRefreshMs) {
    sendFrame(uint8_t(appliedBlue));  // Restore output if the LED supply restarts.
  }
  delay(1);
}
