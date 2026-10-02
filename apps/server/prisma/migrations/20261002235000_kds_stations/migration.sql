-- Kitchen screens with more than one station (P6-05a, KDS-002): the screen's other stations, after
-- `station_id`; none (and no station) is every station, the Expo/Pass view.
ALTER TABLE "devices" ADD COLUMN "extra_station_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
ALTER TABLE "pairing_codes" ADD COLUMN "extra_station_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
