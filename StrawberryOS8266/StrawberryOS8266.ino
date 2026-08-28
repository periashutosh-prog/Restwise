// StrawberryOS - A smartwatch OS for ESP32
// Copyright (C) 2026 Ashutosh
//
// See the LICENSE file for more details.
#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <RTClib.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_GFX.h>
#include <Preferences.h>
#include <esp_sleep.h>
#include <driver/gpio.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

RTC_DS3231 rtc;

#define BTN_UP 2
#define BTN_DOWN 20
#define BTN_LEFT 1
#define BTN_RIGHT 4
#define BTN_CENTER 3

volatile bool buttonStates[5] = {false, false, false, false, false};
const uint8_t buttonPins[5] = {BTN_UP, BTN_DOWN, BTN_LEFT, BTN_RIGHT, BTN_CENTER};

// On the ESP32-C3, GPIO0 and GPIO1 are physically the XTAL_32K_P / XTAL_32K_N
// pads for the optional 32.768kHz crystal (see IO_MUX_GPIO1_REG, which is
// literally #defined to PERIPHS_IO_MUX_XTAL_32K_N_U). BTN_LEFT sits on GPIO1.
//
// If that oscillator is ever enabled, the pad switches to an ANALOG function:
// the digital input buffer and its internal pull-up are disconnected from the
// pad outright, so pinMode(INPUT_PULLUP) and digitalRead() stop meaning
// anything and the pin floats near 0V — i.e. reads as permanently held down,
// which pins lastActivityTime and blocks sleep forever.
//
// That oscillator setting lives in the always-on RTC domain, so it survives a
// soft reset and a reflash; only a full power cycle clears it. That's exactly
// why reflashing never fixed it but jumpering the pin to 3V3 did.
//
// Declared here rather than via <soc/rtc.h> to avoid dragging that header's
// macros into a translation unit that also includes RTClib.
extern "C" void rtc_clk_32k_enable(bool en);
extern "C" bool rtc_clk_32k_enabled(void);
uint8_t statusIndex = 0;
bool isStatusActive = false;

enum ScreenState {
  SCREEN_WATCHFACE, SCREEN_MENU, SCREEN_STOPWATCH, SCREEN_TIMER, SCREEN_TIMER_ALERT,
  SCREEN_CALCULATOR, SCREEN_CALCULATOR_SCI,
  SCREEN_PIN_ENTRY, SCREEN_SECURITY_MENU, SCREEN_SECURITY_CONFIRM,
  SCREEN_LOCK_SETTINGS, SCREEN_TERMINAL
};
ScreenState currentScreen = SCREEN_WATCHFACE;

bool lastButtonStates[5] = {false, false, false, false, false};
bool buttonJustPressed[5] = {false, false, false, false, false};

const int NUM_MENU_ITEMS = 7;
const char* menuItems[NUM_MENU_ITEMS] = {"Stopwatch", "Timer", "Calculator", "Security", "Lock Screen", "Terminal", "Lock"};
int menuIndex = 0;

unsigned long swStartTime = 0;
unsigned long swElapsedTime = 0;
bool swRunning = false;
int swFocus = 0;

enum TimerMode { TM_SETTING, TM_READY, TM_RUNNING, TM_RINGING };
TimerMode tmMode = TM_SETTING;
int tmHours = 0, tmMinutes = 0, tmSeconds = 0;
int tmActiveUnit = 2;
int tmFocus = 1;
unsigned long tmRemainingMillis = 0;
unsigned long tmLastTick = 0;
unsigned long tmSetPressStart = 0;
bool tmLongPressTriggered = false;

bool isAnimating = false;
int animOffsetY = 0;
int animTargetY = 0;
ScreenState animNextScreen = SCREEN_WATCHFACE;

unsigned long lastActivityTime = 0;
const int lockTimeoutOptions[4] = {5, 10, 15, 30};
int displayTimeoutSec = 5;
unsigned long DISPLAY_TIMEOUT_MS = 5000;
const unsigned long DEEP_SLEEP_DELAY_MS = 10000; // fixed 10s after display off
bool displayOn = true;
unsigned long displayOffAt = 0;
int lockSettingsCursor = 0;

Preferences prefs;

// Calculator variables
int calcCursorRow = 0, calcCursorCol = 0;
String calcInput1 = "";
String calcInput2 = "";
char calcOp = ' ';
bool calcIsOpSet = false;
bool calcError = false;

int calcSciRow = 0, calcSciCol = 0;

// SCI functions grid: 3 rows x 2 cols
const char* sciGrid[3][2] = {
  {"x^2",  "sqrt"},
  {"pi",   "x^3"},
  {"cbrt", "BACK"}
};

const char* calcGrid[5][4] = {
  {"7",   "8",  "9",   "/"},
  {"4",   "5",  "6",   "*"},
  {"1",   "2",  "3",   "-"},
  {"0",   ".",  "+",   "="},
  {"<--", "C",  "DEL", "SCI"}
};

// --- Security (PIN only) ---
enum SecurityFlow {
  SEC_NONE,
  SEC_LOCK,        // watchface -> menu gate
  SEC_VERIFY,      // enter current PIN (uses pendingAction)
  SEC_SET_NEW,     // enter new PIN
  SEC_SET_CONFIRM  // confirm new PIN
};
enum SecPendingAction { ACT_NONE, ACT_OPEN_MENU, ACT_CHANGE, ACT_DISABLE };
enum SecConfirmType { CONF_NONE, CONF_ENABLE, CONF_DISABLE };

SecurityFlow securityFlow = SEC_NONE;
SecPendingAction pendingAction = ACT_NONE;
SecConfirmType confirmType = CONF_NONE;
int confirmSelection = 1; // 0=Yes, 1=No
ScreenState pinReturnScreen = SCREEN_MENU;

bool pinSet = false;
String pinStored = "";
String pinBuffer = "";
String pinPendingNew = "";
int pinCursorRow = 0, pinCursorCol = 1;
String pinErrorMsg = "";
unsigned long pinErrorShownAt = 0;

int secMenuCursor = 0; // -1 = back, 0/1 = items

const char* pinKeys[4][3] = {
  {"7", "8", "9"},
  {"4", "5", "6"},
  {"1", "2", "3"},
  {"<", "0", "OK"}
};

// --- Terminal (USB command console) ---
// Wire protocol from strawberry-terminal (Python): a line "CONFIRM <cmd> <args>"
// puts the watch into TERM_CONFIRM, showing <cmd>/<args> with a Yes/No prompt.
// The button choice is sent back as "ACK <cmd> YES" or "ACK <cmd> NO". Only
// "set_time <YYYY-MM-DD HH:MM:SS>" is understood right now (adjusts the RTC).
enum TerminalState { TERM_IDLE, TERM_CONFIRM };
TerminalState termState = TERM_IDLE;
String termLineBuf = "";
String termPendingCmdName = "";
String termPendingArgs = "";
int termConfirmSelection = 0; // 0=Yes, 1=No

// strawberry-terminal sends "PING" every 2s while a session is open (it
// can't just check DTR — it deliberately holds that low to dodge the
// ESP32-C3's USB-CDC reset trigger). A ping within the last 4s means a live
// host is attached; that's what flips the idle screen from "Listening" to
// "Connected!".
bool termConnected = false;
unsigned long termLastPingAt = 0;
const unsigned long TERM_PING_STALE_MS = 4000;

void updateDisplay();
void drawCalculator(int yOffset);
void drawCalculatorSci(int yOffset);
void drawScreen(ScreenState screen, int yOffset);
void drawHeader(int yOffset, const char* appName = nullptr, bool backFocused = false);
void drawWatchFace(int yOffset);
void drawMenu(int yOffset);
void drawStopwatch(int yOffset);
void drawTimer(int yOffset);
void drawTimerAlert(int yOffset);
void drawCenteredText(Adafruit_SSD1306 &d, const String &text, int16_t y, uint8_t size = 1);
void drawBoxedCenteredText(Adafruit_SSD1306 &d, const char* text, int x, int y, int w, int h, bool inverted);
void startAnimation(ScreenState next, int targetOffset);
void buttonReadTask(void *pvParameters);
void printButtonStates();
void drawPinEntry(int yOffset);
void drawSecurityMenu(int yOffset);
void drawSecurityConfirm(int yOffset);
void handlePinSubmit();
void loadSecuritySettings();
void savePinSettings();
void enterPinScreen(SecurityFlow flow, ScreenState returnTo);
void drawLockSettings(int yOffset);
void loadLockSettings();
void saveLockSettings();
void goToDeepSleep();
void drawTerminal(int yOffset);
void processTerminalSerial();
void applyTerminalCommand(bool granted);
void reclaimButtonPins();

void setup() {
  Serial.begin(115200);
  delay(100);

  Wire.begin(9, 10);
  Wire.setClock(400000); // 400kHz I2C for fast, flicker-free OLED refresh
  delay(100);

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("SSD1306 allocation failed"));
    while (1);
  }
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.display();
  delay(100);

  if (!rtc.begin()) {
    Serial.println("RTC not found!");
    display.clearDisplay();
    display.setTextSize(1);
    display.println("RTC Error!");
    display.display();
    while (1);
  }

  Serial.print("32k XTAL osc was: ");
  Serial.println(rtc_clk_32k_enabled() ? "ON (this is the GPIO1 bug)" : "off");

  reclaimButtonPins();

  xTaskCreate(
    buttonReadTask,
    "ButtonReader",
    2048,
    NULL,
    1,
    NULL
  );

  Serial.println("Display and RTC initialized!");

  loadSecuritySettings();
  loadLockSettings();

  lastActivityTime = millis();
}

void loop() {
  bool activityDetected = false;

  for (int i = 0; i < 5; i++) {
    buttonJustPressed[i] = buttonStates[i] && !lastButtonStates[i];
    lastButtonStates[i] = buttonStates[i];
    if (buttonStates[i]) activityDetected = true;
  }

  // Temporary diagnostic: a button pin stuck LOW (e.g. leakage from flux
  // residue) reads as "held down" forever, which keeps activityDetected
  // true every loop and resets the idle timer before it can ever elapse —
  // that's indistinguishable from "never sleeps" at the UI level, since a
  // level-stuck pin doesn't retrigger buttonJustPressed (no repeated nav).
  {
    static unsigned long lastStuckCheck = 0;
    if (activityDetected && millis() - lastStuckCheck > 2000) {
      lastStuckCheck = millis();
      const char* names[5] = {"UP", "DOWN", "LEFT", "RIGHT", "CENTER"};
      Serial.print("[btn] held: ");
      for (int i = 0; i < 5; i++) {
        if (buttonStates[i]) { Serial.print(names[i]); Serial.print(" "); }
      }
      Serial.println();
    }
  }

  if (activityDetected) {
    lastActivityTime = millis();
    if (!displayOn) {
      display.ssd1306_command(SSD1306_DISPLAYON);
      displayOn = true;
      animOffsetY = 0;
      isAnimating = false;
      // Only snap back to the watchface when a PIN is set (so the lock gate
      // re-triggers). Otherwise resume the screen you were on — waking from a
      // brief display timeout shouldn't yank you out of the app you're using.
      // Terminal is the one exception even with a PIN set: it only reads
      // Serial while it's the active screen, so bouncing it to the watchface
      // on every wake silently ate every command sent while blanked — the
      // watch simply never saw them.
      if (pinSet && currentScreen != SCREEN_TERMINAL) currentScreen = SCREEN_WATCHFACE;

      for (int i = 0; i < 5; i++) buttonJustPressed[i] = false;
    }
  }

  // The Terminal app reads Serial only while it's the active screen, so give
  // it a chance to see an incoming command (and wake the display for it)
  // before the sleep/blank decision below runs this same frame.
  if (currentScreen == SCREEN_TERMINAL) {
    processTerminalSerial();
  }

  bool timerActive = (tmMode == TM_RUNNING);
  // With CDCOnBoot=cdc, `Serial` is HWCDC and `(bool)Serial` actually
  // reflects the USB CDC connection state — no longer the DTR proxy it
  // was under the older HardwareSerial config. strawberry-terminal now
  // holds DTR true after opening, so this reads true while a session
  // is live and false when it isn't.
  bool usbConnected = (bool)Serial;

  // Idle power-saving runs on every screen the user might be sitting on
  // (watchface, menu, any app). The single exception is animations —
  // blanking mid-slide would strand the transition halfway. This gives
  // the Lock Screen timeout its intended global effect.
  bool allowBlank = !isAnimating;

  // Full light sleep halts the CPU outright, so it must never engage while
  // something needs the CPU running in the background: a counting-down
  // timer (it wouldn't fire on time), or the Terminal app while a USB host
  // is actually attached (serial commands need the CPU awake to be read).
  // Terminal without a host on the other end sleeps normally — no reason
  // to burn power waiting for something that isn't there.
  bool allowLightSleep = allowBlank && !timerActive && !(currentScreen == SCREEN_TERMINAL && usbConnected);

  if (displayOn && allowBlank) {
    if (millis() - lastActivityTime > DISPLAY_TIMEOUT_MS) {
      display.ssd1306_command(SSD1306_DISPLAYOFF);
      displayOn = false;
      displayOffAt = millis();
    }
  }

  if (!displayOn && allowLightSleep) {
    if (millis() - displayOffAt > DEEP_SLEEP_DELAY_MS) {
      goToDeepSleep();
    }
  }

  if (!displayOn && currentScreen == SCREEN_STOPWATCH && swRunning) {
      display.ssd1306_command(SSD1306_DISPLAYON);
      displayOn = true;
      lastActivityTime = millis();
  }

  // The timer countdown must keep ticking even while the display is blanked
  // (e.g. you started it and walked back to the watchface) — it used to live
  // inside the `if (displayOn)` block below and silently paused whenever the
  // screen went dark, so the alert could fire late or never wake the display.
  if (tmMode == TM_RUNNING) {
    unsigned long now = millis();
    unsigned long delta = now - tmLastTick;
    if (tmRemainingMillis > delta) {
      tmRemainingMillis -= delta;
      tmLastTick = now;
    } else {
      tmRemainingMillis = 0;
      tmMode = TM_RINGING;
      currentScreen = SCREEN_TIMER_ALERT;
      if (!displayOn) {
        display.ssd1306_command(SSD1306_DISPLAYON);
        displayOn = true;
      }
      lastActivityTime = millis();
    }
  }

  if (displayOn) {

    if (isAnimating) {
      if (animOffsetY < animTargetY) animOffsetY += 8;
      else if (animOffsetY > animTargetY) animOffsetY -= 8;

      if (abs(animOffsetY - animTargetY) < 8) {
        animOffsetY = 0;
        currentScreen = animNextScreen;
        isAnimating = false;
      }
    } else {

      if (currentScreen == SCREEN_WATCHFACE) {
        if (buttonJustPressed[0]) {
          if (pinSet) {
            enterPinScreen(SEC_LOCK, SCREEN_WATCHFACE);
          } else {
            startAnimation(SCREEN_MENU, -64);
          }
        }
      }
      else if (currentScreen == SCREEN_MENU) {
        if (buttonJustPressed[0]) {
          menuIndex = (menuIndex - 1 + NUM_MENU_ITEMS) % NUM_MENU_ITEMS;
        }
        if (buttonJustPressed[1]) {
          menuIndex = (menuIndex + 1) % NUM_MENU_ITEMS;
        }
        if (buttonJustPressed[4]) {
          if (menuIndex == 0) {
            swFocus = 1;
            startAnimation(SCREEN_STOPWATCH, -64);
          } else if (menuIndex == 1) {
            tmMode = TM_SETTING;
            tmFocus = 1;
            startAnimation(SCREEN_TIMER, -64);
          } else if (menuIndex == 2) {
            calcCursorRow = 0; calcCursorCol = 0;
            calcInput1 = ""; calcInput2 = ""; calcOp = ' '; calcIsOpSet = false; calcError = false;
            startAnimation(SCREEN_CALCULATOR, -64);
          } else if (menuIndex == 3) {
            if (pinSet) {
              pendingAction = ACT_OPEN_MENU;
              enterPinScreen(SEC_VERIFY, SCREEN_MENU);
            } else {
              confirmType = CONF_ENABLE;
              confirmSelection = 0;
              startAnimation(SCREEN_SECURITY_CONFIRM, -64);
            }
          } else if (menuIndex == 4) {
            lockSettingsCursor = -1;
            for (int i = 0; i < 4; i++) if (lockTimeoutOptions[i] == displayTimeoutSec) lockSettingsCursor = i;
            if (lockSettingsCursor == -1) lockSettingsCursor = 0;
            startAnimation(SCREEN_LOCK_SETTINGS, -64);
          } else if (menuIndex == 5) {
            termState = TERM_IDLE;
            termLineBuf = "";
            startAnimation(SCREEN_TERMINAL, -64);
          } else if (menuIndex == 6) {
            startAnimation(SCREEN_WATCHFACE, 64);
          }
        }
      }
      else if (currentScreen == SCREEN_STOPWATCH) {

        if (buttonJustPressed[0]) {
          if (swFocus == 1 || swFocus == 2) swFocus = 0;
        }
        if (buttonJustPressed[1]) {
          if (swFocus == 0) swFocus = 1;
        }
        if (buttonJustPressed[2]) {
          if (swFocus == 2) swFocus = 1;
        }
        if (buttonJustPressed[3]) {
          if (swFocus == 1) swFocus = 2;
        }

        if (buttonJustPressed[4]) {
          if (swFocus == 0) {
            startAnimation(SCREEN_MENU, 64);
          } else if (swFocus == 1) {
            if (swRunning) {
              swElapsedTime += millis() - swStartTime;
              swRunning = false;
            } else {
              swStartTime = millis();
              swRunning = true;
            }
          } else if (swFocus == 2) {
            if (swRunning) {
              swElapsedTime += millis() - swStartTime;
              swRunning = false;
            } else {
              swElapsedTime = 0;
            }
          }
        }
      }
      else if (currentScreen == SCREEN_TIMER) {

        if (buttonJustPressed[0]) {
          if (tmFocus > 0) tmFocus = 0;
        }
        if (buttonJustPressed[1]) {
          if (tmFocus == 0) tmFocus = 1;
        }
        if (buttonJustPressed[2]) {
          if (tmMode == TM_SETTING) {
            if (tmFocus == 2) tmFocus = 1;
            else if (tmFocus == 3) tmFocus = 2;
            else if (tmFocus == 1) tmFocus = 0;
          } else if (tmMode == TM_READY) {
            if (tmFocus == 3) tmFocus = 1;
            else if (tmFocus == 1) tmFocus = 0;
          }
        }
        if (buttonJustPressed[3]) {
          if (tmMode == TM_SETTING) {
            if (tmFocus == 1) tmFocus = 2;
            else if (tmFocus == 2) tmFocus = 3;
          } else if (tmMode == TM_READY) {
            if (tmFocus == 1) tmFocus = 3;
          }
        }

        if (buttonStates[4] && tmFocus == 2 && tmMode == TM_SETTING) {
          if (tmSetPressStart == 0) tmSetPressStart = millis();
          if (millis() - tmSetPressStart > 2000 && !tmLongPressTriggered) {
            tmMode = TM_READY;
            tmFocus = 3;
            tmLongPressTriggered = true;

          }
        } else {
          tmSetPressStart = 0;
          tmLongPressTriggered = false;
        }

        if (buttonJustPressed[4]) {
          if (tmFocus == 0) {
            startAnimation(SCREEN_MENU, 64);
          }
          else if (tmMode == TM_SETTING) {
            if (tmFocus == 1) {
              if (tmActiveUnit == 0) tmHours = (tmHours + 1) % 24;
              else if (tmActiveUnit == 1) tmMinutes = (tmMinutes + 1) % 60;
              else if (tmActiveUnit == 2) tmSeconds = (tmSeconds + 1) % 60;
            } else if (tmFocus == 2) {
              tmActiveUnit = (tmActiveUnit + 1) % 3;
            } else if (tmFocus == 3) {
              if (tmActiveUnit == 0) tmHours = (tmHours + 23) % 24;
              else if (tmActiveUnit == 1) tmMinutes = (tmMinutes + 59) % 60;
              else if (tmActiveUnit == 2) tmSeconds = (tmSeconds + 59) % 60;
            }
          }
          else if (tmMode == TM_READY) {
            if (tmFocus == 1) tmMode = TM_SETTING;
            else if (tmFocus == 3) {
              tmRemainingMillis = ((unsigned long)tmHours * 3600 + tmMinutes * 60 + tmSeconds) * 1000;
              if (tmRemainingMillis > 0) {
                tmMode = TM_RUNNING;
                tmLastTick = millis();
              }
            }
          }
          else if (tmMode == TM_RUNNING) {
            if (tmFocus == 1) tmMode = TM_READY;
            else if (tmFocus == 3) {

            }
          }
        }
      }
      else if (currentScreen == SCREEN_TIMER_ALERT) {
        if (buttonJustPressed[0] || buttonJustPressed[1] || buttonJustPressed[2] ||
            buttonJustPressed[3] || buttonJustPressed[4]) {
          tmMode = TM_SETTING;
          startAnimation(SCREEN_WATCHFACE, 64);
        }
      }
      else if (currentScreen == SCREEN_CALCULATOR) {
        // Navigation: 5 rows x 4 cols, wrap around
        if (buttonJustPressed[0]) calcCursorRow = (calcCursorRow > 0) ? calcCursorRow - 1 : 4;
        if (buttonJustPressed[1]) calcCursorRow = (calcCursorRow < 4) ? calcCursorRow + 1 : 0;
        if (buttonJustPressed[2]) {
          calcCursorCol--;
          if (calcCursorCol < 0) calcCursorCol = 3;
        }
        if (buttonJustPressed[3]) {
          calcCursorCol++;
          if (calcCursorCol > 3) calcCursorCol = 0;
        }

        if (buttonJustPressed[4]) {
          const char* key = calcGrid[calcCursorRow][calcCursorCol];
          String keyStr = String(key);

          if (keyStr == "<--") {
            calcInput1 = ""; calcInput2 = ""; calcOp = ' '; calcIsOpSet = false; calcError = false;
            startAnimation(SCREEN_MENU, 64);

          } else if (keyStr == "C") {
            calcInput1 = ""; calcInput2 = ""; calcOp = ' '; calcIsOpSet = false; calcError = false;

          } else if (keyStr == "DEL") {
            if (calcError) { calcInput1 = ""; calcInput2 = ""; calcOp = ' '; calcIsOpSet = false; calcError = false; }
            else if (calcIsOpSet) {
              if (calcInput2.length() > 0) calcInput2.remove(calcInput2.length() - 1);
              else { calcIsOpSet = false; calcOp = ' '; }
            } else {
              if (calcInput1.length() > 0) calcInput1.remove(calcInput1.length() - 1);
            }

          } else if (keyStr == "=") {
            if (!calcError && calcIsOpSet && calcInput2.length() > 0) {
              float v1 = calcInput1.toFloat(), v2 = calcInput2.toFloat(), res = 0;
              bool dz = false;
              if (calcOp=='+') res=v1+v2;
              else if (calcOp=='-') res=v1-v2;
              else if (calcOp=='*') res=v1*v2;
              else if (calcOp=='/') { if (v2!=0) res=v1/v2; else dz=true; }
              if (dz) { calcError = true; }
              else {
                calcInput1 = String(res, 4);
                while (calcInput1.endsWith("0") && calcInput1.indexOf(".")!=-1) calcInput1.remove(calcInput1.length()-1);
                if (calcInput1.endsWith(".")) calcInput1.remove(calcInput1.length()-1);
                calcInput2 = ""; calcOp = ' '; calcIsOpSet = false;
              }
            }

          } else if (keyStr=="+" || keyStr=="-" || keyStr=="*" || keyStr=="/") {
            char op = key[0];
            if (!calcError && calcInput1.length() > 0) {
              if (calcIsOpSet && calcInput2.length() > 0) {
                float v1=calcInput1.toFloat(), v2=calcInput2.toFloat(), res=0;
                bool dz=false;
                if (calcOp=='+') res=v1+v2;
                else if (calcOp=='-') res=v1-v2;
                else if (calcOp=='*') res=v1*v2;
                else if (calcOp=='/') { if (v2!=0) res=v1/v2; else dz=true; }
                if (dz) { calcError=true; }
                else {
                  calcInput1=String(res,4);
                  while(calcInput1.endsWith("0")&&calcInput1.indexOf(".")!=-1) calcInput1.remove(calcInput1.length()-1);
                  if(calcInput1.endsWith(".")) calcInput1.remove(calcInput1.length()-1);
                  calcInput2=""; calcOp=op; calcIsOpSet=true;
                }
              } else { calcOp=op; calcIsOpSet=true; }
            }

          } else if (keyStr == "SCI") {
            calcSciRow = 0; calcSciCol = 0;
            startAnimation(SCREEN_CALCULATOR_SCI, -64);

          } else if (keyStr != "") {
            // digit or .
            if (calcError) { calcInput1=""; calcInput2=""; calcOp=' '; calcIsOpSet=false; calcError=false; }
            if (calcIsOpSet) {
              if (keyStr=="." && calcInput2.indexOf(".")!=-1) {}
              else if (calcInput2.length()<10) calcInput2 += keyStr;
            } else {
              if (keyStr=="." && calcInput1.indexOf(".")!=-1) {}
              else if (calcInput1.length()<10) calcInput1 += keyStr;
            }
          }
        }
      }

      else if (currentScreen == SCREEN_CALCULATOR_SCI) {
        if (buttonJustPressed[0]) calcSciRow = (calcSciRow > 0) ? calcSciRow - 1 : 2;
        if (buttonJustPressed[1]) calcSciRow = (calcSciRow < 2) ? calcSciRow + 1 : 0;
        if (buttonJustPressed[2]) calcSciCol = (calcSciCol > 0) ? calcSciCol - 1 : 1;
        if (buttonJustPressed[3]) calcSciCol = (calcSciCol < 1) ? calcSciCol + 1 : 0;

        if (buttonJustPressed[4]) {
          const char* key = sciGrid[calcSciRow][calcSciCol];

          // BACK just goes back; every other key applies a function first. This
          // used to "return" out of loop() entirely, skipping the frame render.
          if (strcmp(key, "BACK") != 0) {
            // Apply SCI function to active input
            String* activeInput = calcIsOpSet ? &calcInput2 : &calcInput1;
            float v = activeInput->toFloat();
            bool hasVal = (activeInput->length() > 0 && !calcError);
            String result = "";
            bool sciError = false;

            if (strcmp(key, "x^2") == 0) {
              if (hasVal) result = String(v * v, 4);
            } else if (strcmp(key, "sqrt") == 0) {
              if (hasVal && v >= 0) result = String(sqrt(v), 4);
              else sciError = true;
            } else if (strcmp(key, "pi") == 0) {
              result = "3.14159265";
            } else if (strcmp(key, "x^3") == 0) {
              if (hasVal) result = String(v * v * v, 4);
            } else if (strcmp(key, "cbrt") == 0) {
              if (hasVal) {
                float cb = (v >= 0) ? pow(v, 1.0f/3.0f) : -pow(-v, 1.0f/3.0f);
                result = String(cb, 4);
              }
            }

            if (sciError) {
              calcError = true;
            } else if (result.length() > 0) {
              // Trim trailing zeros
              while (result.endsWith("0") && result.indexOf(".") != -1) result.remove(result.length()-1);
              if (result.endsWith(".")) result.remove(result.length()-1);
              // If pi was inserted into empty, set as calcInput1 directly
              if (strcmp(key, "pi") == 0) {
                if (!calcIsOpSet) calcInput1 = result;
                else calcInput2 = result;
              } else {
                *activeInput = result;
              }
            }
          }
          startAnimation(SCREEN_CALCULATOR, 64);
        }
      }

      else if (currentScreen == SCREEN_PIN_ENTRY) {
        // Uniform 4x3 grid, matching cyberdeck.ino's numpad exactly.
        if (buttonJustPressed[0]) pinCursorRow = (pinCursorRow > 0) ? pinCursorRow - 1 : 3;
        if (buttonJustPressed[1]) pinCursorRow = (pinCursorRow < 3) ? pinCursorRow + 1 : 0;
        if (buttonJustPressed[2]) pinCursorCol = (pinCursorCol > 0) ? pinCursorCol - 1 : 2;
        if (buttonJustPressed[3]) pinCursorCol = (pinCursorCol < 2) ? pinCursorCol + 1 : 0;

        if (buttonJustPressed[4]) {
          const char* key = pinKeys[pinCursorRow][pinCursorCol];
          if (strcmp(key, "<") == 0) {
            if (pinBuffer.length() > 0) {
              pinBuffer.remove(pinBuffer.length() - 1);
            } else {
              pinBuffer = ""; pinPendingNew = ""; pinErrorMsg = "";
              securityFlow = SEC_NONE;
              pendingAction = ACT_NONE;
              startAnimation(pinReturnScreen, 64);
            }
          } else if (strcmp(key, "OK") == 0) {
            if (pinBuffer.length() == 4) handlePinSubmit();
          } else {
            if (pinBuffer.length() < 4) {
              pinBuffer += key;
              if (pinBuffer.length() == 4) handlePinSubmit();
            }
          }
        }
      }
      else if (currentScreen == SCREEN_SECURITY_MENU) {
        if (buttonJustPressed[0]) {
          secMenuCursor = (secMenuCursor > -1) ? secMenuCursor - 1 : 1;
        }
        if (buttonJustPressed[1]) {
          secMenuCursor = (secMenuCursor < 1) ? secMenuCursor + 1 : -1;
        }
        if (buttonJustPressed[4]) {
          if (secMenuCursor == -1) {
            startAnimation(SCREEN_MENU, 64);
          } else if (secMenuCursor == 0) {
            // Change PIN — verify current first
            pendingAction = ACT_CHANGE;
            enterPinScreen(SEC_VERIFY, SCREEN_SECURITY_MENU);
          } else if (secMenuCursor == 1) {
            // Turn Off — verify current first
            pendingAction = ACT_DISABLE;
            enterPinScreen(SEC_VERIFY, SCREEN_SECURITY_MENU);
          }
        }
      }
      else if (currentScreen == SCREEN_SECURITY_CONFIRM) {
        if (buttonJustPressed[2]) confirmSelection = 0;
        if (buttonJustPressed[3]) confirmSelection = 1;
        if (buttonJustPressed[4]) {
          bool yes = (confirmSelection == 0);
          if (confirmType == CONF_ENABLE) {
            if (yes) {
              pinReturnScreen = SCREEN_MENU;
              pendingAction = ACT_OPEN_MENU;
              pinBuffer = ""; pinPendingNew = ""; pinErrorMsg = "";
              pinCursorRow = 0; pinCursorCol = 1;
              securityFlow = SEC_SET_NEW;
              startAnimation(SCREEN_PIN_ENTRY, -64);
            } else {
              confirmType = CONF_NONE;
              startAnimation(SCREEN_MENU, 64);
            }
          } else if (confirmType == CONF_DISABLE) {
            if (yes) {
              pinSet = false;
              pinStored = "";
              savePinSettings();
              confirmType = CONF_NONE;
              pendingAction = ACT_NONE;
              startAnimation(SCREEN_MENU, 64);
            } else {
              confirmType = CONF_NONE;
              startAnimation(SCREEN_SECURITY_MENU, 64);
            }
          }
        }
      }
      else if (currentScreen == SCREEN_LOCK_SETTINGS) {
        if (buttonJustPressed[0]) {
          lockSettingsCursor = (lockSettingsCursor > -1) ? lockSettingsCursor - 1 : 3;
        }
        if (buttonJustPressed[1]) {
          lockSettingsCursor = (lockSettingsCursor < 3) ? lockSettingsCursor + 1 : -1;
        }
        if (buttonJustPressed[4]) {
          if (lockSettingsCursor == -1) {
            startAnimation(SCREEN_MENU, 64);
          } else {
            int chosen = lockTimeoutOptions[lockSettingsCursor];
            if (chosen != displayTimeoutSec) {
              displayTimeoutSec = chosen;
              DISPLAY_TIMEOUT_MS = (unsigned long)displayTimeoutSec * 1000UL;
              saveLockSettings();
            }
          }
        }
      }
      else if (currentScreen == SCREEN_TERMINAL) {
        if (termState == TERM_IDLE) {
          if (buttonJustPressed[4]) {
            startAnimation(SCREEN_MENU, 64);
          }
        } else if (termState == TERM_CONFIRM) {
          if (buttonJustPressed[2]) termConfirmSelection = 0; // LEFT  -> Yes
          if (buttonJustPressed[3]) termConfirmSelection = 1; // RIGHT -> No
          if (buttonJustPressed[4]) {
            applyTerminalCommand(termConfirmSelection == 0);
            termState = TERM_IDLE;
          }
        }
      }
    }

    if (pinErrorMsg.length() > 0 && millis() - pinErrorShownAt > 1500) pinErrorMsg = "";

    static unsigned long lastStatusUpdate = 0;
    if (millis() - lastStatusUpdate > 100) {
      statusIndex++;
      lastStatusUpdate = millis();
    }

    updateDisplay();
  }

  delay(5);
}
void startAnimation(ScreenState next, int targetOffset) {
  isAnimating = true;
  animNextScreen = next;
  animOffsetY = 0;
  animTargetY = targetOffset;
}

void updateDisplay() {
  display.clearDisplay();

  if (isAnimating) {
    if (animTargetY < 0) {
      drawScreen(currentScreen, animOffsetY);
      drawScreen(animNextScreen, animOffsetY + 64);
    } else {
      drawScreen(currentScreen, animOffsetY);
      drawScreen(animNextScreen, animOffsetY - 64);
    }
  } else {
    drawScreen(currentScreen, 0);
  }

  display.display();
}

void drawScreen(ScreenState screen, int yOffset) {
  if (screen == SCREEN_WATCHFACE) drawWatchFace(yOffset);
  else if (screen == SCREEN_MENU) drawMenu(yOffset);
  else if (screen == SCREEN_STOPWATCH) drawStopwatch(yOffset);
  else if (screen == SCREEN_TIMER) drawTimer(yOffset);
  else if (screen == SCREEN_TIMER_ALERT) drawTimerAlert(yOffset);
  else if (screen == SCREEN_CALCULATOR) drawCalculator(yOffset);
  else if (screen == SCREEN_CALCULATOR_SCI) drawCalculatorSci(yOffset);
  else if (screen == SCREEN_PIN_ENTRY) drawPinEntry(yOffset);
  else if (screen == SCREEN_SECURITY_MENU) drawSecurityMenu(yOffset);
  else if (screen == SCREEN_SECURITY_CONFIRM) drawSecurityConfirm(yOffset);
  else if (screen == SCREEN_LOCK_SETTINGS) drawLockSettings(yOffset);
  else if (screen == SCREEN_TERMINAL) drawTerminal(yOffset);
}

void drawHeader(int yOffset, const char* appName, bool backFocused) {

  display.drawFastHLine(0, 12 + yOffset, 128, SSD1306_WHITE);

  if (appName != nullptr) {
    display.setTextSize(1);

    if (backFocused) {
      display.fillRect(0, yOffset, 24, 12, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
    } else {
      display.setTextColor(SSD1306_WHITE);
    }

    display.setCursor(2, 2 + yOffset);
    display.print("<--");

    display.setTextColor(SSD1306_WHITE);
    int16_t x1, y1; uint16_t w, h;
    display.getTextBounds(appName, 0, 0, &x1, &y1, &w, &h);

    display.setCursor((128 - w) / 2 - x1, 12/2 - h/2 - y1 + yOffset);
    display.print(appName);
  } else {
    display.setTextColor(SSD1306_WHITE);
    if (isStatusActive) {
      uint8_t dotPos = (statusIndex % 8) * 16;
      display.fillRect(dotPos, 2 + yOffset, 8, 4, SSD1306_WHITE);
    }
  }
}

void drawWatchFace(int yOffset) {

  drawHeader(yOffset);

  DateTime now = rtc.now();
  uint16_t hour = now.hour();
  bool isPM = hour >= 12;
  if (hour > 12) hour -= 12;
  else if (hour == 0) hour = 12;

  char timeBuf[6];
  sprintf(timeBuf, "%02d:%02d", hour, now.minute());
  display.setTextSize(4);
  display.setTextColor(SSD1306_WHITE);
  int16_t x1, y1; uint16_t w, h;
  display.getTextBounds(timeBuf, 0, 0, &x1, &y1, &w, &h);

  int16_t xPos = (128 - w + 1) / 2 - x1;
  int16_t yPos = 13 + (43 - h + 1) / 2 - y1 + yOffset;
  display.setCursor(xPos, yPos);
  display.print(timeBuf);

  display.setTextSize(1);
  display.setCursor(128 - 14, 56 + yOffset);
  display.print(isPM ? "PM" : "AM");

  display.setCursor(0, 56 + yOffset);
  const char* days[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
  char dateBuf[16];
  sprintf(dateBuf, "%02d/%02d/%04d %s", now.day(), now.month(), now.year(), days[now.dayOfTheWeek()]);
  display.print(dateBuf);
}

void drawMenu(int yOffset) {
  drawHeader(yOffset);

  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  const char* title = "APPS";
  int titleX = 64 - (strlen(title) * 3);
  display.setCursor(max(0, titleX), 2 + yOffset);
  display.print(title);

  int itemH = 12;
  int listY = 16 + yOffset;

  int startIdx = (menuIndex < 4) ? 0 : menuIndex - 3;
  int endIdx = min(startIdx + 4, (int)NUM_MENU_ITEMS);

  for (int i = startIdx; i < endIdx; i++) {
    int y = listY + ((i - startIdx) * itemH);

    if (i == menuIndex) {
      display.fillRect(0, y-1, 128, itemH, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
    } else {
      display.setTextColor(SSD1306_WHITE);
    }

    display.setCursor(4, y);
    display.print(menuItems[i]);
  }
}

void drawStopwatch(int yOffset) {
  drawHeader(yOffset, "STOPWATCH", (swFocus == 0));

  unsigned long currentTotal = swElapsedTime;
  if (swRunning) {
    currentTotal += millis() - swStartTime;
  }

  unsigned long ms = (currentTotal % 1000) / 10;
  unsigned long totalSecs = currentTotal / 1000;
  unsigned long m = totalSecs / 60;
  unsigned long s = totalSecs % 60;

  char timeStr[10];
  sprintf(timeStr, "%02lu:%02lu", m, s);
  display.setTextSize(3);
  display.setTextColor(SSD1306_WHITE);
  int16_t x1, y1; uint16_t w, h;
  display.getTextBounds(timeStr, 0, 0, &x1, &y1, &w, &h);
  int16_t xPos = (SCREEN_WIDTH - w) / 2 - x1;
  int16_t yPos = 10 + (42 - h) / 2 - y1 + yOffset;
  display.setCursor(xPos, yPos);
  display.print(timeStr);

  char msStr[4];
  sprintf(msStr, "%02lu", ms);
  display.setTextSize(1);
  display.setCursor(SCREEN_WIDTH - 16, 16 + yOffset);
  display.print(msStr);

  display.setTextSize(1);

  const char* leftBtn = swRunning ? "PAUSE" : "START";
  int16_t lx1, ly1; uint16_t lw, lh;
  display.getTextBounds(leftBtn, 0, 0, &lx1, &ly1, &lw, &lh);
  int leftBtnX = (64 - (lw + 8)) / 2;
  drawBoxedCenteredText(display, leftBtn, leftBtnX, SCREEN_HEIGHT - 12 + yOffset, lw + 8, 11, (swFocus == 1));

  const char* rightBtn = swRunning ? "STOP" : "RESET";
  int16_t rx1, ry1; uint16_t rw, rh;
  display.getTextBounds(rightBtn, 0, 0, &rx1, &ry1, &rw, &rh);
  int rightBtnX = 64 + (64 - (rw + 8)) / 2;
  drawBoxedCenteredText(display, rightBtn, rightBtnX, SCREEN_HEIGHT - 12 + yOffset, rw + 8, 11, (swFocus == 2));
}

void drawTimer(int yOffset) {
  drawHeader(yOffset, "TIMER", (tmFocus == 0));

  char timeStr[10];
  sprintf(timeStr, "%02d:%02d:%02d", tmHours, tmMinutes, tmSeconds);
  if (tmMode == TM_RUNNING) {
    unsigned long secs = tmRemainingMillis / 1000;
    sprintf(timeStr, "%02lu:%02lu:%02lu", secs / 3600, (secs % 3600) / 60, secs % 60);
  }

  display.setTextSize(2);
  int16_t x1, y1; uint16_t w, h;
  display.getTextBounds(timeStr, 0, 0, &x1, &y1, &w, &h);
  int16_t tx = (128 - w) / 2 - x1;
  int16_t ty = 16 + (28 - h) / 2 - y1 + yOffset;

  display.setCursor(tx, ty);
  display.print(timeStr);

  if (tmMode == TM_SETTING) {
    int charW = 12;
    int16_t unitX = tx + (tmActiveUnit * 3 * charW);
    display.drawFastHLine(unitX, ty + h + 2, 22, SSD1306_WHITE);
  }

  if (tmMode == TM_SETTING) {

    drawBoxedCenteredText(display, "+", 10, 48 + yOffset, 20, 11, (tmFocus == 1));
    drawBoxedCenteredText(display, "SET", 44, 48 + yOffset, 40, 11, (tmFocus == 2));
    drawBoxedCenteredText(display, "-", 98, 48 + yOffset, 20, 11, (tmFocus == 3));
  } else if (tmMode == TM_READY || tmMode == TM_RUNNING) {

    const char* mainBtn = (tmMode == TM_RUNNING) ? "RESET" : "START";
    drawBoxedCenteredText(display, "SET", 15, 48 + yOffset, 40, 11, (tmFocus == 1));
    drawBoxedCenteredText(display, mainBtn, 70, 48 + yOffset, 45, 11, (tmFocus == 3));
  }
}

void drawTimerAlert(int yOffset) {
  bool isFlashOn = (millis() % 1000 < 500);

  if (isFlashOn) {

    display.fillRect(0, 0, 128, 64, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
  } else {

    display.setTextColor(SSD1306_WHITE);
  }

  drawCenteredText(display, "TIMER DONE", 15 + yOffset, 2);
  drawCenteredText(display, "Press any key", 40 + yOffset, 1);

  int x = 51, y = 51 + yOffset, w = 26, h = 11;
  if (isFlashOn) {

    display.fillRect(x, y, w, h, SSD1306_BLACK);
    display.setTextColor(SSD1306_WHITE);
  } else {

    display.fillRect(x, y, w, h, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
  }

  int16_t x1, y1; uint16_t tw, th;
  display.getTextBounds("OK", 0, 0, &x1, &y1, &tw, &th);
  display.setCursor(x + (w - tw) / 2 - x1, y + (h - th) / 2 - y1);
  display.print("OK");

  display.setTextColor(SSD1306_WHITE);
}

void buttonReadTask(void *pvParameters) {
  TickType_t xLastWakeTime = xTaskGetTickCount();
  const TickType_t xFrequency = pdMS_TO_TICKS(50);

  while (1) {

    buttonStates[0] = !digitalRead(BTN_UP);
    buttonStates[1] = !digitalRead(BTN_DOWN);
    buttonStates[2] = !digitalRead(BTN_LEFT);
    buttonStates[3] = !digitalRead(BTN_RIGHT);
    buttonStates[4] = !digitalRead(BTN_CENTER);

    vTaskDelayUntil(&xLastWakeTime, xFrequency);
  }
}

void drawCalculator(int yOffset) {
  // Build display string
  String disp;
  if (calcError) {
    disp = "Err: Div/0";
  } else {
    disp = (calcInput1.length() > 0) ? calcInput1 : "0";
    if (calcIsOpSet) {
      disp += ' '; disp += calcOp;
      if (calcInput2.length() > 0) { disp += ' '; disp += calcInput2; }
    }
  }
  // Clamp display to 18 chars (18*6=108px, leaving room)
  if ((int)disp.length() > 18) disp = disp.substring(disp.length() - 18);

  // --- Display bar: y=0..12 (13px tall) ---
  // Right-align the expression text. Each char = 6px at textSize 1.
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  int dispX = 128 - (int)disp.length() * 6 - 1;
  if (dispX < 0) dispX = 0;
  display.setCursor(dispX, 3 + yOffset);
  display.print(disp);

  // Separator line
  display.drawFastHLine(0, 13 + yOffset, 128, SSD1306_WHITE);

  // --- Button grid: y=14..63 = 50px for 5 rows ---
  // CELL_W=32px (4 cols * 32 = 128), CELL_H=10px (5 rows * 10 = 50, fits in 50)
  const int GY   = 14 + yOffset;
  const int CW   = 32;
  const int CH   = 10;

  for (int r = 0; r < 5; r++) {
    for (int c = 0; c < 4; c++) {
      const char* lbl = calcGrid[r][c];
      if (lbl[0] == '\0') continue; // skip empty cell
      int cx = c * CW;
      int cy = GY + r * CH;
      bool sel = (r == calcCursorRow && c == calcCursorCol);

      if (sel) {
        display.fillRect(cx, cy, CW, CH, SSD1306_WHITE);
        display.setTextColor(SSD1306_BLACK);
      } else {
        display.drawRect(cx, cy, CW, CH, SSD1306_WHITE);
        display.setTextColor(SSD1306_WHITE);
        // Emphasize operator column (col 3) with an extra pixel width
        if (c == 3) display.drawFastVLine(cx + 1, cy, CH, SSD1306_WHITE);
      }
      // Center text: 6px per char at size 1
      int tw = strlen(lbl) * 6;
      int tx = cx + (CW - tw) / 2;
      int ty = cy + (CH - 7) / 2; // proper center padding (10px cell, 7px char = 1.5px top pad)
      display.setCursor(tx, ty);
      display.print(lbl);
    }
  }
  display.setTextColor(SSD1306_WHITE);
}

void drawCalculatorSci(int yOffset) {
  // --- Display bar: show current active value (top 15px) ---
  String activeVal = calcIsOpSet ? calcInput2 : calcInput1;
  if (activeVal.length() == 0) activeVal = "0";
  if (calcError) activeVal = "Error";

  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  // Left: "SCI" label
  display.setCursor(1, 3 + yOffset);
  display.print("SCI");

  // Right: active value right-aligned
  int valX = 128 - (int)activeVal.length() * 6 - 1;
  if (valX < 25) valX = 25;
  display.setCursor(valX, 3 + yOffset);
  display.print(activeVal);

  // Separator
  display.drawFastHLine(0, 13 + yOffset, 128, SSD1306_WHITE);

  // --- SCI grid: 3 rows x 2 cols ---
  // CELL_W=64px (2*64=128), CELL_H=16px (3*16=48, fits 14..63 = 50px)
  const int GY = 15 + yOffset;
  const int CW = 64;
  const int CH = 16;

  for (int r = 0; r < 3; r++) {
    for (int c = 0; c < 2; c++) {
      int cx = c * CW;
      int cy = GY + r * CH;
      bool sel = (r == calcSciRow && c == calcSciCol);
      const char* lbl = sciGrid[r][c];
      if (lbl[0] == '\0') continue;

      if (sel) {
        display.fillRect(cx, cy, CW, CH, SSD1306_WHITE);
        display.setTextColor(SSD1306_BLACK);
      } else {
        display.drawRect(cx, cy, CW, CH, SSD1306_WHITE);
        display.setTextColor(SSD1306_WHITE);
      }
      // Center label in cell
      int tw = strlen(lbl) * 6;
      int tx = cx + (CW - tw) / 2;
      int ty = cy + (CH - 7) / 2; // 7px = char height at size 1
      display.setCursor(tx, ty);
      display.print(lbl);
    }
  }
  display.setTextColor(SSD1306_WHITE);
}

void drawCenteredText(Adafruit_SSD1306 &d, const String &text, int16_t y, uint8_t size) {
  int16_t x1, y1; uint16_t w, h;
  d.setTextSize(size);
  d.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  d.setCursor((SCREEN_WIDTH - w) / 2, y);
  d.print(text);
}

void drawBoxedCenteredText(Adafruit_SSD1306 &d, const char* text, int x, int y, int w, int h, bool inverted) {
  int16_t x1, y1; uint16_t tw, th;
  d.setTextSize(1);
  d.getTextBounds(text, 0, 0, &x1, &y1, &tw, &th);
  if (inverted) {
    d.fillRect(x, y, w, h, SSD1306_WHITE);
    d.setTextColor(SSD1306_BLACK);
  } else {
    d.drawRect(x, y, w, h, SSD1306_WHITE);
    d.setTextColor(SSD1306_WHITE);
  }
  d.setCursor(x + (w - tw) / 2, y + (h - th) / 2);
  d.print(text);
  d.setTextColor(SSD1306_WHITE);
}

void loadSecuritySettings() {
  prefs.begin("security", true);
  pinSet = prefs.getBool("pinSet", false);
  pinStored = prefs.getString("pin", "");
  prefs.end();
}

void savePinSettings() {
  prefs.begin("security", false);
  prefs.putBool("pinSet", pinSet);
  prefs.putString("pin", pinStored);
  prefs.end();
}

void loadLockSettings() {
  prefs.begin("lockscreen", true);
  displayTimeoutSec = prefs.getInt("timeoutSec", 5);
  prefs.end();
  DISPLAY_TIMEOUT_MS = (unsigned long)displayTimeoutSec * 1000UL;
}

void saveLockSettings() {
  prefs.begin("lockscreen", false);
  prefs.putInt("timeoutSec", displayTimeoutSec);
  prefs.end();
}

// Force every button pad back to plain digital GPIO with a pull-up, undoing
// anything that may have claimed it. Order matters: kill the 32k oscillator
// first (that's what steals GPIO0/GPIO1 as XTAL_32K_P/N and disconnects their
// digital input + pull-up), release any pad hold, then reset the IO_MUX back
// to the GPIO function, and only then set the direction/pull-up. This board
// has no 32.768kHz crystal — timekeeping comes from the DS3231 over I2C — so
// that oscillator is never legitimately wanted here.
void reclaimButtonPins() {
  rtc_clk_32k_enable(false);
  gpio_deep_sleep_hold_dis();

  for (int i = 0; i < 5; i++) {
    gpio_hold_dis((gpio_num_t)buttonPins[i]);
    gpio_reset_pin((gpio_num_t)buttonPins[i]);
  }

  for (int i = 0; i < 5; i++) {
    pinMode(buttonPins[i], INPUT_PULLUP);
  }
}

void goToDeepSleep() {
  // ESP32-C3 has no GPIO-based *deep*-sleep wakeup at all (ext0/ext1 are
  // ESP32/S2-only; multi-pin GPIO deep-sleep wakeup is C6/H2-only). Light
  // sleep is the only mode on this chip where any digital pin can wake it,
  // so that's what actually runs here — still halts the CPU and gates
  // clocks for real power savings, and resumes in-place (no reboot).
  Serial.println("Entering light sleep (wake: any button)...");
  Serial.flush();

  esp_sleep_enable_gpio_wakeup();
  for (int i = 0; i < 5; i++) {
    gpio_wakeup_enable((gpio_num_t)buttonPins[i], GPIO_INTR_LOW_LEVEL);
  }

  esp_light_sleep_start();

  for (int i = 0; i < 5; i++) {
    gpio_wakeup_disable((gpio_num_t)buttonPins[i]);
  }

  // Light sleep is where the pads are most likely to get re-hijacked, so
  // fully reclaim them here too rather than just re-asserting pinMode.
  reclaimButtonPins();

  // Bare DISPLAYON isn't enough after light sleep. The I2C peripheral pauses
  // with the CPU, and mid-transaction resumes leave the SSD1306's internal
  // command parser out of sync with what the driver thinks — subsequent
  // writes then land on the bus fine but the panel stays blank, which is
  // exactly the "display hangs blank, buttons still work" symptom. Fix by
  // resetting the I2C bus and re-running the display's init sequence, so the
  // OLED state machine is guaranteed known-good before we touch the buffer.
  Wire.begin(9, 10);
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);

  displayOn = true;
  currentScreen = SCREEN_WATCHFACE;
  animOffsetY = 0;
  isAnimating = false;
  lastActivityTime = millis();
  for (int i = 0; i < 5; i++) buttonJustPressed[i] = false;
}

void enterPinScreen(SecurityFlow flow, ScreenState returnTo) {
  pinBuffer = ""; pinPendingNew = ""; pinErrorMsg = "";
  pinCursorRow = 0; pinCursorCol = 1;
  securityFlow = flow;
  pinReturnScreen = returnTo;
  startAnimation(SCREEN_PIN_ENTRY, -64);
}

void handlePinSubmit() {
  if (securityFlow == SEC_LOCK) {
    if (pinBuffer == pinStored) {
      pinBuffer = "";
      securityFlow = SEC_NONE;
      startAnimation(SCREEN_MENU, -64);
    } else {
      pinErrorMsg = "Wrong PIN";
      pinErrorShownAt = millis();
      pinBuffer = "";
    }
  } else if (securityFlow == SEC_VERIFY) {
    if (pinBuffer == pinStored) {
      pinBuffer = "";
      if (pendingAction == ACT_OPEN_MENU) {
        secMenuCursor = 0;
        securityFlow = SEC_NONE;
        pendingAction = ACT_NONE;
        startAnimation(SCREEN_SECURITY_MENU, -64);
      } else if (pendingAction == ACT_CHANGE) {
        securityFlow = SEC_SET_NEW;
        pinCursorRow = 0; pinCursorCol = 1;
      } else if (pendingAction == ACT_DISABLE) {
        confirmType = CONF_DISABLE;
        confirmSelection = 1;
        securityFlow = SEC_NONE;
        pendingAction = ACT_NONE;
        startAnimation(SCREEN_SECURITY_CONFIRM, -64);
      }
    } else {
      pinErrorMsg = "Wrong PIN";
      pinErrorShownAt = millis();
      pinBuffer = "";
    }
  } else if (securityFlow == SEC_SET_NEW) {
    pinPendingNew = pinBuffer;
    pinBuffer = "";
    securityFlow = SEC_SET_CONFIRM;
  } else if (securityFlow == SEC_SET_CONFIRM) {
    if (pinBuffer == pinPendingNew) {
      pinStored = pinBuffer;
      pinSet = true;
      savePinSettings();
      pinBuffer = ""; pinPendingNew = "";
      securityFlow = SEC_NONE;
      SecPendingAction wasAction = pendingAction;
      pendingAction = ACT_NONE;
      // From Change flow -> back to security menu; from Enable flow -> main menu.
      startAnimation((wasAction == ACT_CHANGE) ? SCREEN_SECURITY_MENU : SCREEN_MENU, 64);
    } else {
      pinErrorMsg = "PINs didn't match";
      pinErrorShownAt = millis();
      pinBuffer = ""; pinPendingNew = "";
      securityFlow = SEC_SET_NEW;
    }
  }
}

void drawPinEntry(int yOffset) {
  const char* hdr = "PIN";
  if (securityFlow == SEC_VERIFY || securityFlow == SEC_LOCK) hdr = "Enter PIN";
  else if (securityFlow == SEC_SET_NEW) hdr = "New PIN";
  else if (securityFlow == SEC_SET_CONFIRM) hdr = "Confirm PIN";

  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  int hdrLen = strlen(hdr);
  int hdrX = 64 - (hdrLen * 3);
  display.setCursor(max(0, hdrX), 2 + yOffset);
  display.print(hdr);

  // Digit indicators: 4 boxes (10 wide x 9 tall), y=10..19.
  const int boxW = 10, boxH = 9, boxGap = 6;
  const int totalW = boxW * 4 + boxGap * 3;
  const int startX = (128 - totalW) / 2;
  const int boxY = 10 + yOffset;

  if (pinErrorMsg.length() > 0) {
    drawCenteredText(display, pinErrorMsg, 12 + yOffset, 1);
  } else {
    for (int i = 0; i < 4; i++) {
      int x = startX + i * (boxW + boxGap);
      if (i < (int)pinBuffer.length()) {
        display.fillRect(x, boxY, boxW, boxH, SSD1306_WHITE);
      } else {
        display.drawRect(x, boxY, boxW, boxH, SSD1306_WHITE);
      }
    }
  }

  // Numpad: uniform 4x3 grid, y=22..62. keyH=10 gives digit glyphs vertical
  // padding; starts 3px below the digit boxes so nothing overlaps.
  const int padX = 34;
  const int padY = 22 + yOffset;
  const int keyW = 18, keyH = 10, colStep = 20, rowStep = 10;

  for (int r = 0; r < 4; r++) {
    for (int c = 0; c < 3; c++) {
      int x = padX + c * colStep;
      int y = padY + r * rowStep;
      bool sel = (pinCursorRow == r && pinCursorCol == c);
      drawBoxedCenteredText(display, pinKeys[r][c], x, y, keyW, keyH, sel);
    }
  }

  display.setTextColor(SSD1306_WHITE);
}

void drawSecurityMenu(int yOffset) {
  // Back arrow (<--) top-left, "Security" title centered.
  display.setTextSize(1);
  bool backSel = (secMenuCursor == -1);
  if (backSel) {
    display.fillRect(0, yOffset, 22, 12, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
  } else {
    display.setTextColor(SSD1306_WHITE);
  }
  display.setCursor(2, 2 + yOffset);
  display.print("<--");

  display.setTextColor(SSD1306_WHITE);
  const char* title = "Security";
  int titleX = 64 - (strlen(title) * 3);
  display.setCursor(max(0, titleX), 2 + yOffset);
  display.print(title);
  display.drawFastHLine(0, 12 + yOffset, 128, SSD1306_WHITE);

  const char* items[2] = {"Change PIN", "Turn Off Security"};
  for (int i = 0; i < 2; i++) {
    int y = 18 + (i * 14) + yOffset;
    if (i == secMenuCursor) {
      display.fillRect(2, y - 1, 124, 11, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
    } else {
      display.setTextColor(SSD1306_WHITE);
    }
    display.setCursor(6, y);
    display.print(items[i]);
  }
  display.setTextColor(SSD1306_WHITE);
}

void drawSecurityConfirm(int yOffset) {
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  const char* q1 = "";
  const char* q2 = "";
  if (confirmType == CONF_ENABLE) {
    q1 = "Turn on security?";
    q2 = "";
  } else {
    q1 = "Turn off security?";
    q2 = "Are you sure?";
  }

  drawCenteredText(display, q1, 12 + yOffset, 1);
  if (q2[0]) drawCenteredText(display, q2, 26 + yOffset, 1);

  int by = 46 + yOffset;
  int bw = 40, bh = 12;
  drawBoxedCenteredText(display, "Yes", 14, by, bw, bh, (confirmSelection == 0));
  drawBoxedCenteredText(display, "No",  74, by, bw, bh, (confirmSelection == 1));

  display.setTextColor(SSD1306_WHITE);
}

void drawLockSettings(int yOffset) {
  display.setTextSize(1);
  bool backSel = (lockSettingsCursor == -1);
  if (backSel) {
    display.fillRect(0, yOffset, 22, 12, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
  } else {
    display.setTextColor(SSD1306_WHITE);
  }
  display.setCursor(2, 2 + yOffset);
  display.print("<--");

  display.setTextColor(SSD1306_WHITE);
  const char* title = "Lock Screen";
  int titleX = 64 - (strlen(title) * 3);
  display.setCursor(max(0, titleX), 2 + yOffset);
  display.print(title);
  display.drawFastHLine(0, 12 + yOffset, 128, SSD1306_WHITE);

  for (int i = 0; i < 4; i++) {
    int y = 16 + (i * 11) + yOffset;
    char label[16];
    sprintf(label, "%d seconds", lockTimeoutOptions[i]);

    if (i == lockSettingsCursor) {
      display.fillRect(2, y - 1, 124, 11, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
    } else {
      display.setTextColor(SSD1306_WHITE);
    }
    display.setCursor(6, y);
    display.print(label);
    if (lockTimeoutOptions[i] == displayTimeoutSec) display.print(" (ON)");
  }
  display.setTextColor(SSD1306_WHITE);
}

void drawTerminal(int yOffset) {
  bool idle = (termState == TERM_IDLE);
  drawHeader(yOffset, "TERMINAL", idle);
  display.setTextColor(SSD1306_WHITE);

  if (termState == TERM_CONFIRM) {
    drawCenteredText(display, termPendingCmdName, 18 + yOffset, 1);
    if (termPendingArgs.length() > 0) {
      String args = termPendingArgs;
      if ((int)args.length() > 21) args = args.substring(0, 21);
      drawCenteredText(display, args, 28 + yOffset, 1);
    }

    int by = 46 + yOffset;
    int bw = 40, bh = 12;
    drawBoxedCenteredText(display, "Yes", 14, by, bw, bh, (termConfirmSelection == 0));
    drawBoxedCenteredText(display, "No",  74, by, bw, bh, (termConfirmSelection == 1));
  } else {
    drawCenteredText(display, "USB command console", 20 + yOffset, 1);

    bool hostConnected = termConnected && (millis() - termLastPingAt < TERM_PING_STALE_MS);

    // A small sweeping bar to signal "listening for a command" while idle.
    const int boxX = 14, boxY = 38 + yOffset, boxW = 100, boxH = 16;
    display.drawRect(boxX, boxY, boxW, boxH, SSD1306_WHITE);
    drawCenteredText(display, hostConnected ? "Connected!" : "Listening", boxY + 3, 1);

    const int innerW = boxW - 4;
    const int sweepW = 16;
    const int period = (innerW - sweepW) * 2;
    int t = (statusIndex * 2) % period;
    int sweepX = (t <= (innerW - sweepW)) ? t : (period - t);
    display.fillRect(boxX + 2 + sweepX, boxY + boxH - 4, sweepW, 2, SSD1306_WHITE);
  }

  display.setTextColor(SSD1306_WHITE);
}

void processTerminalSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') {
      termLineBuf.trim();
      if (termLineBuf == "PING") {
        termConnected = true;
        termLastPingAt = millis();
      } else if (termLineBuf.startsWith("CONFIRM ")) {
        String rest = termLineBuf.substring(8);
        int sp = rest.indexOf(' ');
        termPendingCmdName = (sp == -1) ? rest : rest.substring(0, sp);
        termPendingArgs = (sp == -1) ? "" : rest.substring(sp + 1);
        termConfirmSelection = 0;
        termState = TERM_CONFIRM;

        // A command arriving must be seen — wake the display immediately.
        if (!displayOn) {
          display.ssd1306_command(SSD1306_DISPLAYON);
          displayOn = true;
        }
        lastActivityTime = millis();
      }
      termLineBuf = "";
    } else if (c != '\r') {
      if (termLineBuf.length() < 96) termLineBuf += c; // guard against a runaway line
    }
  }
}

void applyTerminalCommand(bool granted) {
  if (granted) {
    if (termPendingCmdName == "set_time") {
      int y, mo, d, h, mi, s;
      if (sscanf(termPendingArgs.c_str(), "%d-%d-%d %d:%d:%d", &y, &mo, &d, &h, &mi, &s) == 6) {
        rtc.adjust(DateTime(y, mo, d, h, mi, s));
      }
    }
    Serial.print("ACK "); Serial.print(termPendingCmdName); Serial.println(" YES");
  } else {
    Serial.print("ACK "); Serial.print(termPendingCmdName); Serial.println(" NO");
  }
  termPendingCmdName = "";
  termPendingArgs = "";
}
