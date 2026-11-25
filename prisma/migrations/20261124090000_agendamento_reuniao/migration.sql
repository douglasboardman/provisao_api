BEGIN;
ALTER TABLE item_pauta_reuniao ADD COLUMN id TEXT DEFAULT gen_random_uuid()::text NOT NULL;
ALTER TABLE item_pauta_reuniao DROP CONSTRAINT item_pauta_reuniao_pkey,
  ADD PRIMARY KEY (id),
  ADD CONSTRAINT item_pauta_reuniao_reuniao_id_ordem_key UNIQUE (reuniao_id, ordem) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE reuniao ADD COLUMN local_efetivo_id TEXT, ADD COLUMN local_efetivo_retrato JSONB,
  ADD CONSTRAINT reuniao_local_efetivo_fkey FOREIGN KEY (local_efetivo_id, igreja_id)
    REFERENCES local_reuniao(id, igreja_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
COMMIT;
