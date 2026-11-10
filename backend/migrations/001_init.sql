-- Family Portfolio schema. Static data (ledger, balances, instruments) and cached live data are kept apart.

create table owner (
  id serial primary key,
  code text not null unique,          -- Personal | HUF | Sravanthi
  label text not null
);

create table account (
  id serial primary key,
  owner_id int not null references owner(id),
  kind text not null,                 -- DEMAT | MF_FOLIO | PMS | ULIP_POLICY | FOREIGN_BROKER | PF | NPS | BANK
  label text not null,
  meta jsonb not null default '{}',   -- e.g. ULIP policy cost, insurer, status
  unique (owner_id, kind, label)
);

create table instrument (
  id serial primary key,
  asset_class text not null,          -- EQUITY_IN | EQUITY_SG | MF | ULIP_FUND | INDEX | FX | OTHER
  name text not null,
  short_name text,
  symbol text,
  exchange text,
  isin text,
  amfi_code text,
  currency text not null default 'INR',
  plan text,                          -- Direct | Regular | null
  option_type text,
  provider_symbols jsonb not null default '{}',   -- how each provider names it
  symbol_verified boolean not null default false,
  active boolean not null default true,
  meta jsonb not null default '{}',
  unique (asset_class, name)
);
create index instrument_amfi on instrument(amfi_code);

-- The ledger: source of truth for quantities and cost.
create table txn (
  id bigserial primary key,
  account_id int not null references account(id),
  instrument_id int not null references instrument(id),
  trade_date date not null,
  type text not null check (type in ('OPENING','BUY','SELL','SIP','SWITCH_IN','SWITCH_OUT','DIVIDEND','BONUS','SPLIT','DEMERGER','TRANSFER_IN','TRANSFER_OUT','VEST','FEE')),
  bucket text not null default 'AVAILABLE' check (bucket in ('AVAILABLE','UNVESTED')),
  quantity numeric(24,8),
  price numeric(24,8),
  amount numeric(24,4),               -- in instrument currency
  currency text not null default 'INR',
  fx_rate numeric(18,8),
  amount_inr numeric(24,4),           -- cost or proceeds in INR
  charges numeric(24,4) not null default 0,
  ratio_num numeric(24,8),            -- SPLIT / DEMERGER: new units per ratio_den old units
  ratio_den numeric(24,8),
  cost_fraction numeric(10,8),        -- DEMERGER: share of parent cost moved to ref_instrument_id
  ref_instrument_id int references instrument(id),
  notes text,
  source text not null default 'manual',   -- manual | seed | csv-import
  import_batch_id int,
  created_by text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index txn_account on txn(account_id, trade_date, id);
create index txn_instrument on txn(instrument_id);

-- Derived from the ledger (rebuilt per account after any ledger change).
create table tax_lot (
  id bigserial primary key,
  account_id int not null references account(id),
  instrument_id int not null references instrument(id),
  bucket text not null,
  source_txn_id bigint not null,
  acquired date not null,
  opening boolean not null default false,
  qty numeric(24,8) not null,
  unit_cost_inr numeric(24,8) not null
);
create index tax_lot_acc on tax_lot(account_id, instrument_id);

create table holding (
  account_id int not null references account(id),
  instrument_id int not null references instrument(id),
  bucket text not null,
  quantity numeric(24,8) not null,
  cost_inr numeric(24,4) not null,
  income_inr numeric(24,4) not null default 0,
  primary key (account_id, instrument_id, bucket)
);

create table realised_gain (
  id bigserial primary key,
  account_id int not null references account(id),
  instrument_id int not null references instrument(id),
  sell_txn_id bigint not null,
  lot_txn_id bigint not null,
  qty numeric(24,8) not null,
  acquired date not null,
  sold date not null,
  opening_lot boolean not null default false,
  cost_inr numeric(24,4) not null,
  proceeds_inr numeric(24,4) not null,
  gain_inr numeric(24,4) not null,
  holding_days int not null
);
create index realised_acc on realised_gain(account_id, sold);

create table income (
  id bigserial primary key,
  account_id int not null references account(id),
  instrument_id int not null references instrument(id),
  txn_id bigint not null,
  on_date date not null,
  amount_inr numeric(24,4) not null
);

-- Live data cache. Every row carries provenance.
create table price_cache (
  instrument_id int primary key references instrument(id),
  price numeric(24,8) not null,
  prev_close numeric(24,8),
  prev_as_of date,
  as_of timestamptz not null,
  as_of_date date not null,
  kind text not null,                 -- close | intraday | delayed | nav | manual | seed
  source text not null,
  fetched_at timestamptz not null default now(),
  stale boolean not null default false,
  verify boolean not null default false,
  note text
);

create table price_history (
  instrument_id int not null references instrument(id),
  as_of_date date not null,
  price numeric(24,8) not null,
  kind text not null,
  source text not null,
  primary key (instrument_id, as_of_date)
);

create table fx_rate (
  pair text primary key,              -- e.g. SGDINR
  rate numeric(18,8) not null,
  prev_rate numeric(18,8),
  as_of_date date not null,
  kind text not null default 'reference',
  source text not null,
  fetched_at timestamptz not null default now(),
  verify boolean not null default false
);

create table manual_override (
  id serial primary key,
  instrument_id int not null references instrument(id),
  price numeric(24,8) not null,
  as_of_date date not null,
  reason text,
  entered_by text,
  created_at timestamptz not null default now(),
  active boolean not null default true
);

-- Assets valued "as given": PF, NPS, bank balances, PMS cash.
create table asset_balance (
  id serial primary key,
  owner_id int not null references owner(id),
  kind text not null,                 -- PF | NPS | BANK | PMS_CASH
  label text not null,
  value_inr numeric(24,4) not null,
  cost_inr numeric(24,4),
  as_of date,                         -- null = undated
  meta jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  unique (owner_id, kind, label)
);

create table snapshot (
  snap_date date primary key,
  total_inr numeric(24,4) not null,
  cost_inr numeric(24,4) not null,
  data jsonb not null,
  basis text,
  created_at timestamptz not null default now()
);

create table fund_lookthrough (
  fund_instrument_id int not null references instrument(id),
  stock_name text not null,
  weight numeric(10,4) not null,
  as_of text,
  source text,
  primary key (fund_instrument_id, stock_name)
);

create table fund_allocation (
  fund_instrument_id int primary key references instrument(id),
  debt numeric(10,4) not null default 0,
  other numeric(10,4) not null default 0,
  extra numeric(10,4) not null default 0,
  as_of text,
  source text,
  tag text
);

create table watchlist (
  id serial primary key,
  when_label text,
  category text,
  title text not null,
  detail text,
  note text
);

create table note_flag (
  id serial primary key,
  created_at timestamptz not null default now(),
  text text not null,
  resolved boolean not null default false
);

create table market_holiday (
  day date primary key,
  label text,
  source text
);

create table provider_status (
  provider text primary key,
  enabled boolean not null default true,
  last_success timestamptz,
  last_error text,
  last_error_at timestamptz,
  calls_today int not null default 0,
  calls_day date,
  credential_cipher text
);

create table refresh_run (
  id serial primary key,
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  summary jsonb
);

create table app_user (
  id serial primary key,
  username text not null unique,
  password_hash text not null,
  role text not null default 'admin'
);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  username text,
  entity text not null,
  entity_id text,
  action text not null,
  before jsonb,
  after jsonb
);

create table import_batch (
  id serial primary key,
  filename text,
  kind text not null,
  status text not null default 'previewed',
  rows jsonb not null,
  created_at timestamptz not null default now()
);

create table meta_kv (
  key text primary key,
  value jsonb not null
);
