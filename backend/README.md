# Backend for ESP32 Data Storage

This backend receives data from the ESP32 and stores it in a local SQLite database.

## Setup

1. Open a terminal in the `backend` folder.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the backend:
   ```bash
   npm start
   ```

## API Endpoints

- `POST /api/data`
  - Body JSON example:
    ```json
    {
      "timestamp": "2026-06-14T12:00:00Z",
      "sensor": "temperature",
      "value": 24.5,
      "raw_data": "{"r": 24.5}"
    }
    ```
- `GET /api/data`
  - Returns all stored sensor data
