-- The indexer schema. docs/interfaces.md section 10 names nine tables, and
-- docs/rencana-hari5-indexer.md adds the raw log table, the checkpoint, the block
-- hashes that detect a revert, and four tables the receipt needs.
--
-- Every uint256 is numeric(78,0), never bigint or float. Addresses and hashes are
-- lowercase hex. deployment is the Settlement address, because a fork restarted at
-- the same pinned block rewinds time and reuses batchIds under a new deployment.
--
-- Every row derived from an event carries its provenance, chain_id, block_number,
-- block_timestamp, tx_hash and log_index, and (chain_id, tx_hash, log_index) is
-- what makes a second pass over the same range insert nothing.

CREATE TABLE chain_blocks (
  chain_id      integer  NOT NULL,
  deployment    text     NOT NULL,
  number        bigint   NOT NULL,
  hash          text     NOT NULL,
  parent_hash   text     NOT NULL,
  timestamp     bigint   NOT NULL,
  PRIMARY KEY (chain_id, deployment, number)
);

CREATE TABLE indexer_state (
  chain_id      integer  NOT NULL,
  settlement    text     NOT NULL,
  from_block    bigint   NOT NULL,
  last_block    bigint   NOT NULL,
  last_hash     text     NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, settlement)
);

CREATE TABLE logs (
  chain_id        integer NOT NULL,
  deployment      text    NOT NULL,
  block_number    bigint  NOT NULL,
  block_hash      text    NOT NULL,
  block_timestamp bigint  NOT NULL,
  tx_hash         text    NOT NULL,
  log_index       integer NOT NULL,
  address         text    NOT NULL,
  contract        text    NOT NULL,
  event           text    NOT NULL,
  args            jsonb   NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX logs_block ON logs (chain_id, deployment, block_number);
CREATE INDEX logs_event ON logs (deployment, event);

-- Logs whose topic matched none of the ABIs. Kept rather than dropped, so a
-- contract upgrade that adds an event shows up here instead of vanishing.
CREATE TABLE undecoded_logs (
  chain_id        integer NOT NULL,
  deployment      text    NOT NULL,
  block_number    bigint  NOT NULL,
  tx_hash         text    NOT NULL,
  log_index       integer NOT NULL,
  address         text    NOT NULL,
  topics          jsonb   NOT NULL,
  data            text    NOT NULL,
  error           text    NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);

-- The nine tables of interfaces.md section 10.

CREATE TABLE batches (
  deployment        text          NOT NULL,
  batch_id          numeric(78,0) NOT NULL,
  outcome           text          NOT NULL CHECK (outcome IN ('settled', 'passthrough', 'expired')),
  reason            text,
  session           integer,
  intent_count      integer       NOT NULL,
  netted_usd        numeric(78,0),
  routed_usd        numeric(78,0),
  savings_usd       numeric(78,0),
  solver_fee_usd    numeric(78,0),
  protocol_fee_usd  numeric(78,0),
  solver            text,
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  block_timestamp   bigint        NOT NULL,
  tx_hash           text          NOT NULL,
  log_index         integer       NOT NULL,
  PRIMARY KEY (deployment, batch_id)
);

CREATE TABLE fills (
  deployment        text          NOT NULL,
  batch_id          numeric(78,0) NOT NULL,
  intent_hash       text          NOT NULL,
  owner             text          NOT NULL,
  sell_token        text          NOT NULL,
  buy_token         text          NOT NULL,
  executed_sell     numeric(78,0) NOT NULL,
  executed_buy      numeric(78,0) NOT NULL,
  baseline_buy      numeric(78,0) NOT NULL,
  savings_usd       numeric(78,0) NOT NULL,
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  block_timestamp   bigint        NOT NULL,
  tx_hash           text          NOT NULL,
  log_index         integer       NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX fills_batch ON fills (deployment, batch_id);
CREATE INDEX fills_intent ON fills (deployment, intent_hash);

CREATE TABLE prices (
  deployment        text          NOT NULL,
  batch_id          numeric(78,0) NOT NULL,
  token             text          NOT NULL,
  price             numeric(78,0) NOT NULL,
  ref_price         numeric(78,0) NOT NULL,
  deviation_bps     numeric(78,0) NOT NULL,
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  block_timestamp   bigint        NOT NULL,
  tx_hash           text          NOT NULL,
  log_index         integer       NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX prices_batch ON prices (deployment, batch_id);

CREATE TABLE auctions (
  deployment         text          NOT NULL,
  auction_id         numeric(78,0) NOT NULL,
  token              text          NOT NULL,
  kind               integer       NOT NULL,
  cross_at           bigint        NOT NULL,
  status             text          NOT NULL CHECK (status IN ('open', 'frozen', 'crossed', 'aborted')),
  price              numeric(78,0),
  volume             numeric(78,0),
  participants       integer,
  extensions         integer       NOT NULL DEFAULT 0,
  collar_bps         integer,
  committed_intents  numeric(78,0),
  escrowed_value     numeric(78,0),
  abort_reason       text,
  chain_id           integer       NOT NULL,
  block_number       bigint        NOT NULL,
  block_timestamp    bigint        NOT NULL,
  tx_hash            text          NOT NULL,
  log_index          integer       NOT NULL,
  -- The event that last changed the row, so a crossed auction points at its cross.
  last_block_number  bigint        NOT NULL,
  last_tx_hash       text          NOT NULL,
  last_log_index     integer       NOT NULL,
  PRIMARY KEY (deployment, auction_id)
);

CREATE TABLE indicative (
  deployment        text          NOT NULL,
  auction_id        numeric(78,0) NOT NULL,
  token             text          NOT NULL,
  ts                bigint        NOT NULL,
  price             numeric(78,0) NOT NULL,
  imbalance         numeric(78,0) NOT NULL,
  matched_volume    numeric(78,0) NOT NULL,
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  block_timestamp   bigint        NOT NULL,
  tx_hash           text          NOT NULL,
  log_index         integer       NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);

CREATE TABLE closing_prints (
  deployment        text          NOT NULL,
  token             text          NOT NULL,
  day               bigint        NOT NULL,
  price             numeric(78,0) NOT NULL,
  volume            numeric(78,0) NOT NULL,
  participants      integer       NOT NULL,
  sufficient        boolean       NOT NULL,
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  block_timestamp   bigint        NOT NULL,
  tx_hash           text          NOT NULL,
  log_index         integer       NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);

CREATE TABLE closing_prints_withheld (
  deployment        text          NOT NULL,
  token             text          NOT NULL,
  day               bigint        NOT NULL,
  reason            text          NOT NULL,
  volume            numeric(78,0) NOT NULL,
  participants      integer       NOT NULL,
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  block_timestamp   bigint        NOT NULL,
  tx_hash           text          NOT NULL,
  log_index         integer       NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);

-- One row per solver event rather than one mutable row per solver, so the
-- table can be rolled back by block like every other one. The current standing
-- is the latest row per solver, see solver_standing below.
CREATE TABLE solvers (
  deployment        text          NOT NULL,
  solver            text          NOT NULL,
  event             text          NOT NULL CHECK (event IN ('bonded', 'score', 'slashed', 'unbond_requested')),
  bonded_total      numeric(78,0),
  batches_won       numeric(78,0),
  savings_usd       numeric(78,0),
  slash_amount      numeric(78,0),
  slash_reason      text,
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  block_timestamp   bigint        NOT NULL,
  tx_hash           text          NOT NULL,
  log_index         integer       NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX solvers_solver ON solvers (deployment, solver);

CREATE TABLE sessions (
  deployment        text          NOT NULL,
  kind              text          NOT NULL CHECK (kind IN ('changed', 'protective', 'cleared')),
  ts                bigint        NOT NULL,
  from_session      integer,
  to_session        integer,
  token             text,
  reason            text,
  healthy_updates   integer,
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  block_timestamp   bigint        NOT NULL,
  tx_hash           text          NOT NULL,
  log_index         integer       NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);

-- Supporting tables the receipt needs.

CREATE TABLE solutions (
  deployment        text          NOT NULL,
  batch_id          numeric(78,0) NOT NULL,
  solver            text          NOT NULL,
  solution_hash     text          NOT NULL,
  claimed_savings   numeric(78,0) NOT NULL,
  accepted          boolean       NOT NULL,
  rejection_reason  text,
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  block_timestamp   bigint        NOT NULL,
  tx_hash           text          NOT NULL,
  log_index         integer       NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX solutions_batch ON solutions (deployment, batch_id);

CREATE TABLE venue_routes (
  deployment        text          NOT NULL,
  batch_id          numeric(78,0) NOT NULL,
  adapter           text          NOT NULL,
  token_in          text          NOT NULL,
  token_out         text          NOT NULL,
  amount_in         numeric(78,0) NOT NULL,
  amount_out        numeric(78,0) NOT NULL,
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  block_timestamp   bigint        NOT NULL,
  tx_hash           text          NOT NULL,
  log_index         integer       NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX venue_routes_batch ON venue_routes (deployment, batch_id);

CREATE TABLE collection_failures (
  deployment        text          NOT NULL,
  batch_id          numeric(78,0) NOT NULL,
  owner             text          NOT NULL,
  intent_index      integer       NOT NULL,
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  block_timestamp   bigint        NOT NULL,
  tx_hash           text          NOT NULL,
  log_index         integer       NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX collection_failures_batch ON collection_failures (deployment, batch_id);

-- The winning Solution, decoded from the finalize calldata. minOut, receiver,
-- sellAmount and the intent flags are in no event, and this is their only
-- onchain source. log_index is the closing event the row was fetched for.
CREATE TABLE batch_solutions (
  deployment        text          NOT NULL,
  batch_id          numeric(78,0) NOT NULL,
  solution_hash     text          NOT NULL,
  solution          jsonb         NOT NULL,
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  block_timestamp   bigint        NOT NULL,
  tx_hash           text          NOT NULL,
  log_index         integer       NOT NULL,
  PRIMARY KEY (deployment, batch_id)
);
