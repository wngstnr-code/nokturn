-- quoteFromState answers, read by the indexer while the node still holds the
-- state they were asked at. A fork keeps a few hundred blocks of history and the
-- official mainnet RPC about ten minutes, so a receipt that asked the chain on
-- every open stopped verifying soon after its batch settled.
--
-- amount_out is null when the call reverted, which is an answer and is kept.
-- block_number is the closing event's, so a revert drops the row with its batch.

CREATE TABLE baseline_quotes (
  deployment        text          NOT NULL,
  batch_id          numeric(78,0) NOT NULL,
  adapter           text          NOT NULL,
  sell_token        text          NOT NULL,
  buy_token         text          NOT NULL,
  amount            numeric(78,0) NOT NULL,
  quote_block       bigint        NOT NULL,
  amount_out        numeric(78,0),
  chain_id          integer       NOT NULL,
  block_number      bigint        NOT NULL,
  PRIMARY KEY (deployment, batch_id, adapter, sell_token, buy_token, amount, quote_block)
);
