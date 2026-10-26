#include <Arduino.h>

// GPIO 48 is standard on Espressif DevKitC-1 and YD-ESP32-S3.
// Change to 38 if your specific board revision wires it to GPIO 38.
#ifndef RGB_BUILTIN
#define RGB_BUILTIN 48
#endif

// Brightness limit (0 to 255). 30-50 is plenty bright without blinding you.
const uint8_t BRIGHTNESS = 40; 

void setup() {
    Serial.begin(115200);
    delay(1500); // Wait for USB CDC connection

    Serial.println("\n--- ESP32-S3 N16R8 Test ---");
    Serial.printf("Total PSRAM: %d bytes\n", ESP.getPsramSize());
    Serial.printf("Free PSRAM:  %d bytes\n", ESP.getFreePsram());
    Serial.printf("Flash Size:  %d bytes\n", ESP.getFlashChipSize());
}

void loop() {
    // RED
    Serial.println("LED: RED");
    neopixelWrite(RGB_BUILTIN, BRIGHTNESS, 0, 0);
    delay(500);

    // GREEN
    Serial.println("LED: GREEN");
    neopixelWrite(RGB_BUILTIN, 0, BRIGHTNESS, 0);
    delay(500);

    // BLUE
    Serial.println("LED: BLUE");
    neopixelWrite(RGB_BUILTIN, 0, 0, BRIGHTNESS);
    delay(500);

    // OFF
    Serial.println("LED: OFF");
    neopixelWrite(RGB_BUILTIN, 0, 0, 0);
    delay(500);
}