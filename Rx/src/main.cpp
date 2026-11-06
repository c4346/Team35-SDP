#include <Arduino.h>

// ================= Pin Configuration =================
// Choose any two available GPIOs on your ESP32-S3.
// Make sure to avoid pins used for PSRAM/Flash (GPIO 26-37) or strapping pins.
#define EXTERNAL_UART_RX_PIN 18  // Connect to the external device's TX
#define EXTERNAL_UART_TX_PIN 17  // Connect to the external device's RX

// ================= Baud Rates =================
#define PC_BAUD_RATE         115200  // Speed for Host PC <-> ESP32-S3
#define EXTERNAL_BAUD_RATE   57600  // Speed for ESP32-S3 <-> External Device

// Initialize HardwareSerial for UART1 (ESP32-S3 has UART0, UART1, and UART2)
HardwareSerial ExternalSerial(1);

void setup() {
    // 1. Initialize USB Serial to Host PC
    Serial.begin(PC_BAUD_RATE);

    // Wait a brief moment for native USB CDC to establish (especially useful on S3)
    unsigned long startTime = millis();
    while (!Serial && (millis() - startTime < 3000)) {
        delay(10);
    }

    Serial.println("\n--- ESP32-S3 UART to USB Bridge Starting ---");

    // 2. Initialize the external UART with custom pins
    // begin(baud, config, rxPin, txPin)
    ExternalSerial.begin(EXTERNAL_BAUD_RATE, SERIAL_8N1, EXTERNAL_UART_RX_PIN, EXTERNAL_UART_TX_PIN);

    Serial.printf("Listening on RX: GPIO %d, TX: GPIO %d at %d baud.\n", 
                  EXTERNAL_UART_RX_PIN, EXTERNAL_UART_TX_PIN, EXTERNAL_BAUD_RATE);
}

void loop() {
    // Forward data: External UART -> USB Serial (Host PC)
    while (ExternalSerial.available()) {
        uint8_t byteReceived = ExternalSerial.read();
        Serial.write(byteReceived);
    }

    // Forward data: USB Serial (Host PC) -> External UART
    while (Serial.available()) {
        uint8_t byteToSend = Serial.read();
        ExternalSerial.write(byteToSend);
    }
}