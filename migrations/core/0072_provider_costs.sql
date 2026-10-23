-- COST-001: owner pricing, atomic monthly reservations and anonymous usage ledger.
CREATE TABLE c_provider_cost_settings (
 version INTEGER PRIMARY KEY, model TEXT NOT NULL,
 input_usd_micros_per_million INTEGER NOT NULL CHECK(input_usd_micros_per_million>=0),
 output_usd_micros_per_million INTEGER NOT NULL CHECK(output_usd_micros_per_million>=0),
 reserve_usd_micros INTEGER NOT NULL CHECK(reserve_usd_micros>0),
 cap_usd_micros INTEGER CHECK(cap_usd_micros>=0), set_at TEXT NOT NULL
);
CREATE TABLE c_provider_costs (
 attempt_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('reserved','settled')),
 month TEXT NOT NULL, feature TEXT NOT NULL CHECK(feature IN('receipt-reading','receipt-coding')),
 model TEXT NOT NULL, settings_version INTEGER NOT NULL REFERENCES c_provider_cost_settings(version),
 pages INTEGER NOT NULL CHECK(pages>0), usd_micros INTEGER NOT NULL CHECK(usd_micros>=0),
 input_tokens INTEGER, output_tokens INTEGER, uncertain INTEGER NOT NULL CHECK(uncertain IN(0,1)),
 at TEXT NOT NULL, PRIMARY KEY(attempt_id,kind)
);
CREATE TRIGGER c_provider_cost_settings_immutable BEFORE UPDATE ON c_provider_cost_settings BEGIN SELECT RAISE(ABORT,'provider pricing is versioned'); END;
CREATE TRIGGER c_provider_cost_settings_no_delete BEFORE DELETE ON c_provider_cost_settings BEGIN SELECT RAISE(ABORT,'provider pricing is permanent'); END;
CREATE TRIGGER c_provider_costs_immutable BEFORE UPDATE ON c_provider_costs BEGIN SELECT RAISE(ABORT,'provider cost ledger is append only'); END;
CREATE TRIGGER c_provider_costs_no_delete BEFORE DELETE ON c_provider_costs BEGIN SELECT RAISE(ABORT,'provider cost ledger is permanent'); END;
