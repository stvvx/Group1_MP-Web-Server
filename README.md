# Group1_MP-Web-Server

## Backend Setup

A new `backend` folder has been added to receive ESP32 data and store it in SQLite.

1. Open a terminal in `backend`
2. Run `npm install`
3. Run `npm start`

The backend exposes:

- `POST /api/data` to submit ESP32 sensor data
- `GET /api/data` to retrieve stored records

SQLite file is created at `backend/esp32.db` automatically.
