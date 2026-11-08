-- 守卫补丁：堵住「陈旧回声」回退本地新写的洞。
--
-- 场景：设备 B 加入时先 pull 再基线推送，会把刚拉到的行原样推回云端；
-- 设备 A 后续拉到这些副本时，行内 device_id 与本地相同（都源自 A），
-- 旧守卫的「同设备直接覆盖」规则会把 A 的新编辑回退成旧版本。
--
-- 规则修正（只动 sync_import 的 UPDATE 路径）：
--   · 同设备 + NEW.hlc <  OLD.hlc —— 陈旧回声 / 过期重放：RETURN NULL 拒收，
--     不回退本地、不产生冲突快照（本地版本本来就是同设备的更新写）；
--   · 同设备 + NEW.hlc >= OLD.hlc —— 幂等重试：照旧直接覆盖；
--   · 跨设备 —— 维持 0011 的 LWW + 双向留底语义，一字不改。

CREATE OR REPLACE FUNCTION ca_business_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  importing text;
BEGIN
  importing := coalesce(current_setting('app.sync_import', true), '');

  IF importing = 'on' THEN
    IF NEW.hlc IS NULL OR NEW.hlc = '' THEN NEW.hlc := ca_hlc_next(); END IF;
    PERFORM ca_hlc_observe(NEW.hlc);
    IF TG_OP = 'UPDATE' THEN
      IF OLD.device_id IS DISTINCT FROM NEW.device_id THEN
        IF NEW.hlc > OLD.hlc THEN
          INSERT INTO conflict_snapshots
            (user_id, entity, entity_id, resolution, winner_hlc, loser_hlc, loser_device_id, snapshot)
          VALUES
            (OLD.user_id, TG_TABLE_NAME, coalesce(to_jsonb(OLD)->>'id', TG_TABLE_NAME), 'remote_wins',
             NEW.hlc, OLD.hlc, OLD.device_id, ca_safe_row_json(to_jsonb(OLD)));
          RETURN NEW;
        ELSE
          INSERT INTO conflict_snapshots
            (user_id, entity, entity_id, resolution, winner_hlc, loser_hlc, loser_device_id, snapshot)
          VALUES
            (OLD.user_id, TG_TABLE_NAME, coalesce(to_jsonb(OLD)->>'id', TG_TABLE_NAME), 'local_wins',
             OLD.hlc, NEW.hlc, NEW.device_id, ca_safe_row_json(to_jsonb(NEW)));
          RETURN NULL;
        END IF;
      ELSIF NEW.hlc < OLD.hlc THEN
        -- 0014：同设备但时钟回退 = 陈旧回声（对端把本机旧行推了回来），拒收防回退。
        RETURN NULL;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  NEW.hlc := ca_hlc_next();
  NEW.device_id := coalesce(nullif(current_setting('app.device_id', true), ''), 'local');
  RETURN NEW;
END $$;
