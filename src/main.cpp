// ============================================================
//  COMPLETE SYSTEM: TDS + pH + Feeder + Turbidity + Water Level + Ammonia
//  Board: ESP32
// ============================================================

#include <Wire.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <PubSubClient.h>

// ===== WiFi CONFIGURATION =====
const char* WIFI_SSID = "iPhone";
const char* WIFI_PASSWORD = "bastaa1234";

// ===== PIN DEFINITIONS =====
// TDS Sensor & Pump
#define TDS_SENSOR_PIN   35
#define PUMP_RELAY_PIN   25       // TDS dosing pump relay

// pH Sensor & Relay
#define PH_RELAY_PUMP    18       // pH control pump relay
#define PH_SENSOR_PIN    34

// LDR & Stepper
#define LDR_PIN          36
#define IN1              15
#define IN2              2
#define IN3              4
#define IN4              16

// Turbidity Sensor & Relay
#define TURBIDITY_SENSOR_PIN 33
#define TURBIDITY_RELAY_PIN  19   // Submersible pump relay

// Ultrasonic Sensor & Solenoid Valve
#define TRIG_PIN         21
#define ECHO_PIN         22
#define RELAY_SOLENOID   27

// MQ-135 Ammonia Sensor & Air Pump
#define MQ135_PIN        32
#define AMMONIA_RELAY_PIN 23   // Air pump relay

// ===== TDS CONFIGURATION =====
const int   TDS_THRESHOLD           = 1500;   // ppm - Below = pump ON
const int   SERIAL_UPDATE_INTERVAL_MS = 1000;
const int   SAMPLE_INTERVAL_MS        = 50;
const int   TDS_READ_INTERVAL_MS      = 500;
const float VREF                      = 3.3;
const int   SCOUNT                    = 30;
const float TEMPERATURE               = 28.0;  // °C

// ===== pH CONFIGURATION =====
#define PH_HIGH         7.30
float calibration_value = 21.35;  // Adjust based on your sensor

// ===== LDR & STEPPER CONFIGURATION =====
#define LDR_THRESHOLD       2500    // ADC ≥ this = DARK → motor runs
#define STEP_DELAY_US       1000    // Microseconds between steps
#define STEPS_PER_REV       4096    // 28BYJ-48 half-step = full revolution
#define HALF_TURN           2048    // 180° = hole up <-> hole down
#define DUMP_PAUSE_MS       800    // How long it waits at hole-down (food drops)
#define LDR_INTERVAL_MS     200     // How often to check the LDR
#define FEED_COOLDOWN_MS    5000    // Min gap between feeds (anti-spam)

// ===== TURBIDITY CONFIGURATION =====
#define TURBIDITY_THRESHOLD_NTU 70   // NTU threshold for turbid water

// ===== WATER LEVEL CONFIGURATION =====
const float BOX_HEIGHT_MM = 177.8;   // Tank height (7 inches)
const float LOW_LEVEL     = 40.0;    // Open valve below 40%
const float HIGH_LEVEL    = 50.0;    // Close valve at 50%

// ===== AMMONIA CONFIGURATION =====
float ammoniaThreshold = 4.0;        // ppm threshold for ammonia

// ===== RELAY LOGIC (active LOW relays) =====
#define RELAY_ON   LOW      // Most ESP32 relay modules use LOW to turn ON
#define RELAY_OFF  HIGH     // HIGH to turn OFF

// ===== IR SENSOR + ACTUATOR CONFIGURATION =====
const int IR_SENSOR_PIN = 39;      // IR sensor input
const int RELAY1_PIN = 12;        // Actuator relay IN8
const int RELAY2_PIN = 5;         // Actuator relay IN4

int hitCount = 0;
const int hitsRequired = 1;

const unsigned long debounceDelay = 50;
const unsigned long extendTime = 2000;
const unsigned long retractTime = 6000;
const unsigned long switchDelay = 100;

bool lastSensorState = HIGH;
bool stableSensorState = HIGH;

unsigned long lastDebounceTime = 0;
unsigned long motionTimer = 0;

enum ActuatorState {
  IDLE,
  FULLY_EXTRACTED,
  FULLY_RETRACTED
};

ActuatorState currentState = IDLE;

const char* MQTT_BROKER_HOST = "172.20.10.2";
const uint16_t MQTT_BROKER_PORT = 1883;
const char* MQTT_CLIENT_ID = "group1-mp-esp32";
const char* MQTT_BASE_TOPIC = "group1/mp";

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

// ===== TDS RUNTIME STATE =====
int     analogBuffer[SCOUNT];
int     analogBufferIndex  = 0;
float   tdsValue           = 0;
bool    tdsPumpActive      = false;
unsigned long lastTDSReadTime     = 0;
unsigned long lastTDSSerialTime   = 0;
unsigned long lastTDSSampleTime   = 0;

float lastPHValue = 0;
int lastLDRValue = 0;
bool lastIsDark = false;
int lastTurbidityADC = 0;
int lastTurbidityNTU = 0;
float lastDistanceMM = -1;
float lastWaterLevelMM = 0;
float lastWaterLevelPercent = 0;
String lastFeederMessage = "Idle";
bool manualFeedRequested = false;
unsigned long lastMqttReconnectAttempt = 0;
const unsigned long MQTT_RECONNECT_INTERVAL = 5000;

// ===== TURBIDITY RUNTIME STATE =====
bool lastTurbidityState = false;

// ===== WATER LEVEL RUNTIME STATE =====
bool valveOpen = false;
unsigned long lastWaterLevelReadTime = 0;
const unsigned long WATER_LEVEL_INTERVAL = 500; // Read every 500ms

// ===== AMMONIA RUNTIME STATE =====
float lastAmmoniaPPM = 0;
bool lastAmmoniaState = false;
unsigned long lastAmmoniaReadTime = 0;
const unsigned long AMMONIA_INTERVAL = 1000; // Read every 1 second

// ===== FEEDER RUNTIME STATE =====
bool wasDark = false;
unsigned long lastFeedTime = 0;

// ===== STEPPER HALF-STEP SEQUENCE =====
const int stepSequence[8][4] = {
  {1, 0, 0, 0},
  {1, 1, 0, 0},
  {0, 1, 0, 0},
  {0, 1, 1, 0},
  {0, 0, 1, 0},
  {0, 0, 1, 1},
  {0, 0, 0, 1},
  {1, 0, 0, 1}
};

int currentStep = 0;

// ===== FORWARD DECLARATIONS =====
float readTDS();
int getMedianValue(int *bArray, int bLen);
void controlTDSPump();
void stepMotor();
void releaseMotor();
int readLDR();
float readPH();
void readTurbidityAndControl();
float getDistanceMM();
void readWaterLevelAndControl();
void readAmmoniaAndControl();
void feedOnce();
void rotateSteps(long n);
void setupMqtt();
void connectMqtt();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void publishStatus();
void publishTelemetry();
String mqttTopic(const char* suffix);
String buildStatusJson();

void readSensorAndCountHits();
void startActuatorCycle();
void runActuatorCycle();
void extendActuator();
void retractActuator();
void stopActuator();
void publishActuatorStatus();

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  
  // ----- WiFi SETUP -----
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.disconnect(true, true);

  Serial.println("Scanning nearby WiFi networks...");
  int networkCount = WiFi.scanNetworks();
  bool ssidFound = false;
  for (int index = 0; index < networkCount; index++) {
    String scannedSsid = WiFi.SSID(index);
    if (scannedSsid == WIFI_SSID) {
      ssidFound = true;
      Serial.print("  Found target SSID on channel ");
      Serial.print(WiFi.channel(index));
      Serial.print(" with RSSI ");
      Serial.println(WiFi.RSSI(index));
    }
  }
  if (!ssidFound) {
    Serial.println("  Target SSID not visible in scan results.");
  }

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int wifi_attempts = 0;
  while (WiFi.status() != WL_CONNECTED && wifi_attempts < 20) {
    delay(500);
    Serial.print(".");
    wifi_attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi Connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
    if (MDNS.begin("group1-mp")) {
      MDNS.addService("http", "tcp", 80);
      Serial.println("mDNS responder started: http://group1-mp.local");
    } else {
      Serial.println("⚠️ mDNS responder failed to start");
    }
  } else {
    Serial.println("\n⚠️ WiFi Connection Failed!");
    Serial.print("WiFi status code: ");
    Serial.println((int)WiFi.status());
  }

  setupMqtt();
  
  // Configure ADC
  analogReadResolution(12);       // 12-bit ADC (0-4095)
  analogSetAttenuation(ADC_11db); // Full range 0-3.3V
  
  // ----- TDS PUMP SETUP -----
  pinMode(PUMP_RELAY_PIN, OUTPUT);
  digitalWrite(PUMP_RELAY_PIN, RELAY_OFF);
  
  // ----- pH RELAY SETUP -----
  pinMode(PH_RELAY_PUMP, OUTPUT);
  digitalWrite(PH_RELAY_PUMP, RELAY_OFF);
  
  // ----- TURBIDITY RELAY SETUP -----
  pinMode(TURBIDITY_RELAY_PIN, OUTPUT);
  digitalWrite(TURBIDITY_RELAY_PIN, RELAY_OFF);
  
  // ----- SOLENOID VALVE SETUP -----
  pinMode(RELAY_SOLENOID, OUTPUT);
  digitalWrite(RELAY_SOLENOID, RELAY_OFF);  // Valve OFF initially
  
  // ----- AMMONIA RELAY SETUP -----
  pinMode(AMMONIA_RELAY_PIN, OUTPUT);
  digitalWrite(AMMONIA_RELAY_PIN, RELAY_OFF);  // Air pump OFF initially
  
  // ----- IR SENSOR + ACTUATOR SETUP -----
  // Use internal pull-up to avoid floating input on input-only pins
  // Many IR break-beam / reflective sensors pull the line LOW when triggered.
  pinMode(IR_SENSOR_PIN, INPUT_PULLUP);
  pinMode(RELAY1_PIN, OUTPUT);
  pinMode(RELAY2_PIN, OUTPUT);
  digitalWrite(RELAY1_PIN, HIGH);
  digitalWrite(RELAY2_PIN, HIGH);
  stopActuator();

  // Initialize sensor state from the hardware pin to avoid assuming HIGH
  lastSensorState = digitalRead(IR_SENSOR_PIN);
  stableSensorState = lastSensorState;

  // ----- ULTRASONIC SENSOR SETUP -----
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  
  // ----- STEPPER SETUP -----
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  releaseMotor();
  
  // Initialize TDS buffer
  for (int i = 0; i < SCOUNT; i++) {
    analogBuffer[i] = analogRead(TDS_SENSOR_PIN);
    delay(10);
  }
  
  // ----- PRINT SYSTEM INFO -----
  Serial.println("\n╔════════════════════════════════════════════════════════════════════════════╗");
  Serial.println("║     COMPLETE SYSTEM: TDS + pH + FEEDER + TURBIDITY + WATER + AMMONIA      ║");
  Serial.println("╚════════════════════════════════════════════════════════════════════════════╝");
  
  Serial.println("\n🔵 TDS DOSING SYSTEM:");
  Serial.println("  - TDS Sensor on GPIO 35");
  Serial.println("  - Dosing Pump Relay on GPIO 25");
  Serial.println("  - Threshold: < " + String(TDS_THRESHOLD) + " ppm = PUMP ON");
  
  Serial.println("\n🟢 pH CONTROL SYSTEM:");
  Serial.println("  - pH Sensor on GPIO 34");
  Serial.println("  - Acid Pump Relay on GPIO 18");
  Serial.println("  - pH Threshold: > " + String(PH_HIGH) + " = PUMP ON");
  
  Serial.println("\n🟡 AUTOMATIC FEEDER:");
  Serial.println("  - LDR Sensor on GPIO 36");
  Serial.println("  - LDR Threshold: ≥ " + String(LDR_THRESHOLD) + " = DARK → FEED");
  Serial.println("  - Stepper on GPIO 15, 2, 4, 16");
  Serial.println("  - Steps per revolution: " + String(STEPS_PER_REV));
  Serial.println("  - 180° dump: " + String(HALF_TURN) + " steps");
  Serial.println("  - Pause at dump: " + String(DUMP_PAUSE_MS) + "ms");
  Serial.println("  - Cooldown between feeds: " + String(FEED_COOLDOWN_MS) + "ms");
  
  Serial.println("\n💧 TURBIDITY CONTROL:");
  Serial.println("  - Turbidity Sensor on GPIO 33");
  Serial.println("  - Submersible Pump Relay on GPIO 19");
  Serial.println("  - Threshold: ≥ " + String(TURBIDITY_THRESHOLD_NTU) + " NTU = PUMP ON");
  
  Serial.println("\n💦 WATER LEVEL CONTROL:");
  Serial.println("  - Ultrasonic Sensor: TRIG=GPIO21, ECHO=GPIO22");
  Serial.println("  - Solenoid Valve Relay on GPIO 27");
  Serial.println("  - Threshold: < " + String(LOW_LEVEL) + "% = VALVE OPEN");
  
  Serial.println("\n⚠️ AMMONIA CONTROL:");
  Serial.println("  - MQ-135 Sensor on GPIO 32");
  Serial.println("  - Air Pump Relay on GPIO 23");
  Serial.println("  - Threshold: > " + String(ammoniaThreshold) + " ppm = AIR PUMP ON");

  Serial.println("\n🌐 MQTT DASHBOARD TOPICS:");
  Serial.print("  - Broker: ");
  Serial.print(MQTT_BROKER_HOST);
  Serial.print(":");
  Serial.println(MQTT_BROKER_PORT);
  Serial.print("  - Status: ");
  Serial.println(mqttTopic("status"));
  Serial.print("  - Telemetry: ");
  Serial.println(mqttTopic("telemetry"));
  Serial.print("  - Feed command: ");
  Serial.println(mqttTopic("feed"));
  
  Serial.println("\n════════════════════════════════════════════════════════════════════════════\n");
  
  delay(1000);
}

// ============================================================
//  MAIN LOOP
// ============================================================
void loop() {
  unsigned long now = millis();
  
  // ===== SECTION 1: TDS SENSOR & DOSING PUMP =====
  if (now - lastTDSSampleTime >= SAMPLE_INTERVAL_MS) {
    lastTDSSampleTime = now;
    analogBuffer[analogBufferIndex] = analogRead(TDS_SENSOR_PIN);
    analogBufferIndex = (analogBufferIndex + 1) % SCOUNT;
  }
  
  if (now - lastTDSReadTime >= TDS_READ_INTERVAL_MS) {
    lastTDSReadTime = now;
    tdsValue = readTDS();
    controlTDSPump();
  }
  
  // ===== SECTION 2: pH MONITORING & CONTROL =====
  lastPHValue = readPH();
  
  // ===== SECTION 3: LDR & STEPPER FEEDER (with transition detection) =====
  lastLDRValue = readLDR();
  bool isDark = (lastLDRValue >= LDR_THRESHOLD);
  
  // Trigger once on LIGHT -> DARK transition, after cooldown
  if (isDark && !wasDark && (millis() - lastFeedTime >= FEED_COOLDOWN_MS)) {
    feedOnce();
    lastFeedTime = millis();
  }
  
  wasDark = isDark;
  
  // ===== SECTION 4: TURBIDITY & SUBMERSIBLE PUMP =====
  readTurbidityAndControl();
  
  // ===== SECTION 5: WATER LEVEL & SOLENOID VALVE =====
  if (now - lastWaterLevelReadTime >= WATER_LEVEL_INTERVAL) {
    lastWaterLevelReadTime = now;
    readWaterLevelAndControl();
  }
  
  // ===== SECTION 6: AMMONIA & AIR PUMP =====
  if (now - lastAmmoniaReadTime >= AMMONIA_INTERVAL) {
    lastAmmoniaReadTime = now;
    readAmmoniaAndControl();
  }

  // ===== SECTION 7: IR HIT COUNTER + ACTUATOR =====
  if (currentState == IDLE) {
    readSensorAndCountHits();
  } else {
    runActuatorCycle();
  }

  if (!mqttClient.connected()) {
    connectMqtt();
  } else {
    mqttClient.loop();
  }
  
  // ===== PRINT ALL SENSOR READINGS =====
  if (now - lastTDSSerialTime >= SERIAL_UPDATE_INTERVAL_MS) {
    lastTDSSerialTime = now;

    // Get ammonia reading
    bool ammoniaHigh = (lastAmmoniaPPM > ammoniaThreshold);
    
    Serial.println("┌─────────────────────────────────────────────────────────────────────────────────┐");
    
    // TDS Line
    Serial.print("│ TDS: ");
    Serial.print(tdsValue, 0);
    Serial.print(" ppm  ");
    if (tdsValue < TDS_THRESHOLD) {
      Serial.print("🔵 LOW  → ");
      Serial.print(tdsPumpActive ? "PUMP RUNNING" : "PUMP SHOULD RUN");
    } else {
      Serial.print("🟢 HIGH → ");
      Serial.print(tdsPumpActive ? "PUMP SHOULD STOP" : "PUMP OFF");
    }
    Serial.println("                                                 │");
    
    // pH Line
    Serial.print("│ pH: ");
    Serial.print(lastPHValue, 2);
    Serial.print("  ");
    if (lastPHValue > PH_HIGH) {
      Serial.print("⚠️ HIGH → ACID PUMP ON");
    } else {
      Serial.print("✅ NORMAL → PUMP OFF");
    }
    Serial.println("                                                      │");
    
    // Feeder Line
    Serial.print("│ Feeder: LDR=");
    Serial.print(lastLDRValue);
    Serial.print(" | ");
    Serial.print(isDark ? "🌑 DARK" : "☀️ LIGHT");
    if (isDark && !wasDark) {
      Serial.print(" → TRIGGERING FEED");
    } else {
      Serial.print(" → IDLE");
    }
    Serial.println("                                                            │");
    
    // Turbidity Line
    Serial.print("│ Turbidity: ADC=");
    Serial.print(lastTurbidityADC);
    Serial.print(" | NTU=");
    Serial.print(lastTurbidityNTU);
    Serial.print(" | ");
    if (lastTurbidityNTU >= TURBIDITY_THRESHOLD_NTU) {
      Serial.print("💧 TURBID → PUMP ON");
    } else {
      Serial.print("✅ CLEAN → PUMP OFF");
    }
    Serial.println("                                                   │");
    
    // Water Level Line
    Serial.print("│ Water Level: ");
    Serial.print(lastWaterLevelPercent, 1);
    Serial.print("% | Height: ");
    Serial.print(lastWaterLevelMM, 1);
    Serial.print("mm | Valve: ");
    Serial.print(valveOpen ? "OPEN" : "CLOSED");
    Serial.println("                                                  │");
    
    // Ammonia Line
    Serial.print("│ Ammonia: ");
    Serial.print(lastAmmoniaPPM, 2);
    Serial.print(" ppm | ");
    if (ammoniaHigh) {
      Serial.print("❌ HIGH → AIR PUMP ON");
    } else {
      Serial.print("✅ LOW → AIR PUMP OFF");
    }
    Serial.println("                                                   │");
    
    // Pump Status Line
    Serial.print("│ Pump Status: TDS=");
    Serial.print(tdsPumpActive ? "RUN" : "OFF");
    Serial.print(" | pH=");
    Serial.print(lastPHValue > PH_HIGH ? "RUN" : "OFF");
    Serial.print(" | Turbidity=");
    Serial.print(lastTurbidityNTU >= TURBIDITY_THRESHOLD_NTU ? "RUN" : "OFF");
    Serial.print(" | Ammonia=");
    Serial.print(ammoniaHigh ? "RUN" : "OFF");
    Serial.println("                                                    │");
    
    Serial.println("└─────────────────────────────────────────────────────────────────────────────────┘");
    publishStatus();
    publishTelemetry();
  }
  
  // ===== CONTROL ACTUATORS =====
  
  // Control pH pump
  if (lastPHValue > PH_HIGH) {
    digitalWrite(PH_RELAY_PUMP, RELAY_ON);
  } else {
    digitalWrite(PH_RELAY_PUMP, RELAY_OFF);
  }
  
  // Control manual feed request (MQTT)
  if (manualFeedRequested) {
    manualFeedRequested = false;
    feedOnce();
    lastFeedTime = millis();
  }
  
  delay(LDR_INTERVAL_MS);
}

// ============================================================
//  TDS FUNCTIONS
// ============================================================

float readTDS() {
  int tempBuffer[SCOUNT];
  for (int i = 0; i < SCOUNT; i++) tempBuffer[i] = analogBuffer[i];

  int medianRaw = getMedianValue(tempBuffer, SCOUNT);
  float v = (float)medianRaw * VREF / 4095.0;
  float compensationCoeff = 1.0 + 0.02 * (TEMPERATURE - 25.0);
  float compensatedV = v / compensationCoeff;
  float tds = (133.42 * pow(compensatedV, 3) - 255.86 * pow(compensatedV, 2) + 857.39 * compensatedV) * 0.5;
  
  return tds;
}

int getMedianValue(int *bArray, int bLen) {
  for (int i = 0; i < bLen - 1; i++) {
    for (int j = 0; j < bLen - i - 1; j++) {
      if (bArray[j] > bArray[j + 1]) {
        int temp = bArray[j];
        bArray[j] = bArray[j + 1];
        bArray[j + 1] = temp;
      }
    }
  }
  if (bLen % 2 == 1) return bArray[bLen / 2];
  return (bArray[bLen / 2] + bArray[bLen / 2 - 1]) / 2;
}

void controlTDSPump() {
  if (tdsValue < TDS_THRESHOLD) {
    if (!tdsPumpActive) {
      tdsPumpActive = true;
      digitalWrite(PUMP_RELAY_PIN, RELAY_ON);
      Serial.println("\n💧💧💧 TDS DOSING PUMP TURNED ON (TDS < " + String(TDS_THRESHOLD) + " ppm) 💧💧💧\n");
    }
  } else {
    if (tdsPumpActive) {
      tdsPumpActive = false;
      digitalWrite(PUMP_RELAY_PIN, RELAY_OFF);
      Serial.println("\n⏹️ TDS DOSING PUMP TURNED OFF (TDS ≥ " + String(TDS_THRESHOLD) + " ppm)\n");
    }
  }
}

void setupMqtt() {
  mqttClient.setServer(MQTT_BROKER_HOST, MQTT_BROKER_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024);
}

void connectMqtt() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  unsigned long now = millis();
  if (now - lastMqttReconnectAttempt < MQTT_RECONNECT_INTERVAL) {
    return;
  }
  lastMqttReconnectAttempt = now;

  String clientId = String(MQTT_CLIENT_ID) + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  if (mqttClient.connect(clientId.c_str(), mqttTopic("status/availability").c_str(), 0, true, "offline")) {
    mqttClient.publish(mqttTopic("status/availability").c_str(), "online", true);
    mqttClient.subscribe(mqttTopic("feed").c_str());
    publishStatus();
    publishTelemetry();
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String topicName = String(topic);
  String feedTopic = mqttTopic("feed");
  if (topicName != feedTopic) {
    return;
  }

  String command;
  for (unsigned int i = 0; i < length; i++) {
    command += static_cast<char>(payload[i]);
  }
  command.toLowerCase();

  if (command.indexOf("feed") >= 0 || command.indexOf("1") >= 0 || command.indexOf("on") >= 0) {
    manualFeedRequested = true;
    publishStatus();
  }
}

void publishStatus() {
  if (!mqttClient.connected()) {
    return;
  }

  mqttClient.publish(mqttTopic("status").c_str(), buildStatusJson().c_str(), true);
}

void publishTelemetry() {
  if (!mqttClient.connected()) {
    return;
  }

  String payload = "{";
  payload += "\"tds\":" + String(tdsValue, 1) + ",";
  payload += "\"ph\":" + String(lastPHValue, 2) + ",";
  payload += "\"ldr\":" + String(lastLDRValue) + ",";
  payload += "\"turbidity\":" + String(lastTurbidityNTU) + ",";
  payload += "\"water\":" + String(lastWaterLevelPercent, 1) + ",";
  payload += "\"ammonia\":" + String(lastAmmoniaPPM, 2);
  payload += "}";
  mqttClient.publish(mqttTopic("telemetry").c_str(), payload.c_str(), false);
}

// Publish actuator status to MQTT
void publishActuatorStatus() {
  if (!mqttClient.connected()) return;

  String stateStr = "IDLE";
  if (currentState == FULLY_EXTRACTED) stateStr = "EXTENDING";
  else if (currentState == FULLY_RETRACTED) stateStr = "RETRACTING";

  // include raw IR sensor readings
  String sensorState = (stableSensorState == LOW) ? "LOW" : "HIGH";

  String payload = "{";
  payload += "\"timestamp\":\"" + String(millis()) + "\",";
  payload += "\"hitCount\":" + String(hitCount) + ",";
  payload += "\"state\":\"" + stateStr + "\",";
  payload += "\"running\":" + String(currentState != IDLE ? "true" : "false") + ",";
  payload += "\"ir_sensor\":\"" + sensorState + "\",";
  payload += "\"stable\":" + String(stableSensorState == LOW ? "true" : "false");
  payload += "}";

  mqttClient.publish(mqttTopic("actuator").c_str(), payload.c_str(), true);
}

String mqttTopic(const char* suffix) {
  return String(MQTT_BASE_TOPIC) + "/" + suffix;
}

String buildStatusJson() {
  String json = "{";
  json += "\"device\":\"Group1_MP\",";
  json += "\"wifiConnected\":" + String(WiFi.status() == WL_CONNECTED ? "true" : "false") + ",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"tds\":{";
  json += "\"value\":" + String(tdsValue, 1) + ",";
  json += "\"threshold\":" + String(TDS_THRESHOLD) + ",";
  json += "\"pumpActive\":" + String(tdsPumpActive ? "true" : "false") + "},";
  json += "\"ph\":{";
  json += "\"value\":" + String(lastPHValue, 2) + ",";
  json += "\"threshold\":" + String(PH_HIGH, 2) + ",";
  json += "\"pumpActive\":" + String(lastPHValue > PH_HIGH ? "true" : "false") + "},";
  json += "\"feeder\":{";
  json += "\"ldrValue\":" + String(lastLDRValue) + ",";
  json += "\"threshold\":" + String(LDR_THRESHOLD) + ",";
  json += "\"isDark\":" + String(lastIsDark ? "true" : "false") + ",";
  json += "\"lastMessage\":\"" + lastFeederMessage + "\"},";
  json += "\"turbidity\":{";
  json += "\"adc\":" + String(lastTurbidityADC) + ",";
  json += "\"ntu\":" + String(lastTurbidityNTU) + ",";
  json += "\"threshold\":" + String(TURBIDITY_THRESHOLD_NTU) + ",";
  json += "\"pumpActive\":" + String(lastTurbidityNTU >= TURBIDITY_THRESHOLD_NTU ? "true" : "false") + "},";
  json += "\"waterLevel\":{";
  json += "\"distanceMm\":" + String(lastDistanceMM, 1) + ",";
  json += "\"heightMm\":" + String(lastWaterLevelMM, 1) + ",";
  json += "\"percentage\":" + String(lastWaterLevelPercent, 1) + ",";
  json += "\"valveOpen\":" + String(valveOpen ? "true" : "false") + "},";
  json += "\"ammonia\":{";
  json += "\"ppm\":" + String(lastAmmoniaPPM, 2) + ",";
  json += "\"threshold\":" + String(ammoniaThreshold, 2) + ",";
  json += "\"pumpActive\":" + String(lastAmmoniaPPM > ammoniaThreshold ? "true" : "false") + "}";
  json += "}";
  return json;
}

// ============================================================
//  pH SENSOR FUNCTION
// ============================================================
float readPH() {
  int buffer_arr[10];
  int temp;
  unsigned long int avgval;
  
  for (int i = 0; i < 10; i++) {
    buffer_arr[i] = analogRead(PH_SENSOR_PIN);
    delay(30);
  }
  
  for (int i = 0; i < 9; i++) {
    for (int j = i + 1; j < 10; j++) {
      if (buffer_arr[i] > buffer_arr[j]) {
        temp = buffer_arr[i];
        buffer_arr[i] = buffer_arr[j];
        buffer_arr[j] = temp;
      }
    }
  }
  
  avgval = 0;
  for (int i = 2; i < 8; i++) {
    avgval += buffer_arr[i];
  }
  
  float volt = (float)avgval * 3.3 / 4095.0 / 6;
  float pH = -5.70 * volt + calibration_value;
  
  return pH;
}

// ============================================================
//  LDR SENSOR FUNCTION (with averaging)
// ============================================================
int readLDR() {
  long sum = 0;
  const int samples = 5;
  for (int i = 0; i < samples; i++) {
    sum += analogRead(LDR_PIN);
    delay(2);
  }
  return (int)(sum / samples);
}

// ============================================================
//  TURBIDITY FUNCTION
// ============================================================
void readTurbidityAndControl() {
  int read_ADC = analogRead(TURBIDITY_SENSOR_PIN);

  lastTurbidityADC = read_ADC;
  
  if (read_ADC > 2500) read_ADC = 2500;
  int ntu = map(read_ADC, 0, 2500, 300, 0);
  lastTurbidityNTU = ntu;
  
  if (ntu < TURBIDITY_THRESHOLD_NTU) {
    if (lastTurbidityState != false) {
      Serial.println("\n💧💧💧 WATER IS CLEAN - SUBMERSIBLE PUMP OFF 💧💧💧\n");
      lastTurbidityState = false;
    }
    digitalWrite(TURBIDITY_RELAY_PIN, RELAY_OFF);
  } else {
    if (lastTurbidityState != true) {
      Serial.println("\n🌊🌊🌊 WATER IS TURBID - SUBMERSIBLE PUMP ON 🌊🌊🌊\n");
      lastTurbidityState = true;
    }
    digitalWrite(TURBIDITY_RELAY_PIN, RELAY_ON);
  }
}

// ============================================================
//  WATER LEVEL FUNCTIONS
// ============================================================
float getDistanceMM() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  
  if (duration == 0) {
    return -1; // Error
  }

  float distanceMM = (duration * 0.343) / 2;
  return distanceMM;
}

void readWaterLevelAndControl() {
  float distance = getDistanceMM();
  lastDistanceMM = distance;
  
  if (distance < 0 || distance > 2000) {
    lastWaterLevelMM = 0;
    lastWaterLevelPercent = 0;
    Serial.println("Water Level | Sensor reading error!");
    return;
  }

  float waterLevel = BOX_HEIGHT_MM - distance;
  
  if (waterLevel < 0) waterLevel = 0;
  if (waterLevel > BOX_HEIGHT_MM) waterLevel = BOX_HEIGHT_MM;
  lastWaterLevelMM = waterLevel;
  
  float percentage = (waterLevel / BOX_HEIGHT_MM) * 100.0;
  lastWaterLevelPercent = percentage;
  
  // Control solenoid valve
  if (percentage < LOW_LEVEL && !valveOpen) {
    digitalWrite(RELAY_SOLENOID, RELAY_ON);
    valveOpen = true;
    Serial.println("\n💦💦💦 VALVE OPENED - Water level low 💦💦💦\n");
  }
  
  if (percentage >= HIGH_LEVEL && valveOpen) {
    digitalWrite(RELAY_SOLENOID, RELAY_OFF);
    valveOpen = false;
    Serial.println("\n⏹️⏹️⏹️ VALVE CLOSED - Water level sufficient ⏹️⏹️⏹️\n");
  }
}

// ============================================================
//  FEEDER FUNCTIONS (with 180° dump, pause, 180° back to home)
// ============================================================
void feedOnce() {
  lastFeederMessage = "Feeding cycle started";
  Serial.println("\n🌑🌑🌑 FEEDING CYCLE STARTED: 180° dump, pause, 180° return 🌑🌑🌑");
  
  Serial.println("  🔄 Rotating 180° -> hole DOWN");
  rotateSteps(HALF_TURN);          // hole now faces down (180°)
  releaseMotor();                  // gear friction holds it in place

  Serial.print("  ⏸️ Pausing ");
  Serial.print(DUMP_PAUSE_MS / 1000.0, 1);
  Serial.println("s -> food dropping");
  delay(DUMP_PAUSE_MS);            // wait while pellets fall

  Serial.println("  🔄 Rotating 180° -> back HOME (hole up)");
  rotateSteps(HALF_TURN);          // completes full 360°, hole up again
  releaseMotor();

  Serial.println("✅✅✅ FEEDING CYCLE COMPLETE - Ready for next feed ✅✅✅\n");
  publishStatus();
}

// Rotate n half-steps forward
void rotateSteps(long n) {
  for (long i = 0; i < n; i++) {
    stepMotor();
    delayMicroseconds(STEP_DELAY_US);
  }
}

// ============================================================
//  AMMONIA FUNCTION
// ============================================================
void readAmmoniaAndControl() {
  int sensorValue = analogRead(MQ135_PIN);
  
  // Convert ADC value to estimated ammonia ppm
  // Adjust this formula based on your sensor calibration
  float ammoniaPPM = (sensorValue / 4095.0) * 10.0;
  lastAmmoniaPPM = ammoniaPPM;
  
  bool ammoniaHigh = (ammoniaPPM > ammoniaThreshold);
  
  // Control air pump based on ammonia level
  if (ammoniaHigh) {
    if (!lastAmmoniaState) {
      Serial.println("\n⚠️⚠️⚠️ HIGH AMMONIA DETECTED - AIR PUMP TURNED ON ⚠️⚠️⚠️\n");
      lastAmmoniaState = true;
    }
    digitalWrite(AMMONIA_RELAY_PIN, RELAY_ON);
  } else {
    if (lastAmmoniaState) {
      Serial.println("\n✅✅✅ AMMONIA LEVEL NORMAL - AIR PUMP TURNED OFF ✅✅✅\n");
      lastAmmoniaState = false;
    }
    digitalWrite(AMMONIA_RELAY_PIN, RELAY_OFF);
  }
}

// ============================================================
//  IR SENSOR + ACTUATOR FUNCTIONS
// ============================================================
void readSensorAndCountHits() {
  bool currentSensorState = digitalRead(IR_SENSOR_PIN);

  if (currentSensorState != lastSensorState) {
    lastDebounceTime = millis();
  }

  if ((millis() - lastDebounceTime) > debounceDelay) {
    if (currentSensorState != stableSensorState) {
      stableSensorState = currentSensorState;

      if (stableSensorState == LOW) {
        hitCount++;
        Serial.print("![🔴](https://static.xx.fbcdn.net/images/emoji.php/v9/t6e/1/16/1f534.png) HIT #");
        Serial.println(hitCount);
        
          // Publish hit update
          publishActuatorStatus();

        if (hitCount >= hitsRequired) {
          startActuatorCycle();
        }
      }
    }
  }

  lastSensorState = currentSensorState;
}

void startActuatorCycle() {
  hitCount = 0;
  currentState = FULLY_EXTRACTED;
  motionTimer = millis();
  extendActuator();
  Serial.println("![▶](https://static.xx.fbcdn.net/images/emoji.php/v9/t40/1/16/25b6.png) FULLY EXTRACTED (EXTENDING)");
  
    // Publish actuator start
    publishActuatorStatus();
}

void runActuatorCycle() {
  unsigned long elapsed = millis() - motionTimer;

  if (currentState == FULLY_EXTRACTED) {
    if (elapsed >= extendTime) {
      stopActuator();
      delay(switchDelay);
      currentState = FULLY_RETRACTED;
      motionTimer = millis();
      retractActuator();
      Serial.println("![◀](https://static.xx.fbcdn.net/images/emoji.php/v9/td9/1/16/25c0.png) FULLY RETRACTED (RETRACTING)");
      
        // Publish actuator state change
        publishActuatorStatus();
    }
  } else if (currentState == FULLY_RETRACTED) {
    if (elapsed >= retractTime) {
      stopActuator();
      currentState = IDLE;
      Serial.println("![✅](https://static.xx.fbcdn.net/images/emoji.php/v9/t33/1/16/2705.png) CYCLE COMPLETE (FULLY HOME)");
      Serial.println();
      
        // Publish actuator cycle complete
        publishActuatorStatus();
    }
  }
}

void extendActuator() {
  digitalWrite(RELAY1_PIN, LOW);
  digitalWrite(RELAY2_PIN, LOW);
}

void retractActuator() {
  digitalWrite(RELAY1_PIN, HIGH);
  digitalWrite(RELAY2_PIN, HIGH);
}

void stopActuator() {
  digitalWrite(RELAY1_PIN, LOW);
  digitalWrite(RELAY2_PIN, HIGH);
}

// ============================================================
//  STEPPER FUNCTIONS
// ============================================================
void stepMotor() {
  digitalWrite(IN1, stepSequence[currentStep][0]);
  digitalWrite(IN2, stepSequence[currentStep][1]);
  digitalWrite(IN3, stepSequence[currentStep][2]);
  digitalWrite(IN4, stepSequence[currentStep][3]);
  currentStep = (currentStep + 1) % 8;
}

void releaseMotor() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}