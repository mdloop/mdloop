-- Phase 18: external guest sharing. A guest is a users row with role 'guest'
-- (synthetic workos_user_id 'guest:<uuid>' — a real WorkOS sign-in can never
-- resolve to one), so comments' composite FK and RLS apply unchanged. The
-- grant itself is an ordinary user-grantee share_grants row that now carries
-- an expiry and the external email it was issued to. Expiry is enforced at
-- read time (listForUser/byTokenHash exclude expired rows) — no sweep.

alter table users drop constraint users_role_check;
alter table users
  add constraint users_role_check check (role in ('admin', 'member', 'guest'));

alter table share_grants
  add column expires_at timestamptz,
  add column grantee_email text;

-- The original token check said "only link grants carry tokens". Guest grants
-- are user-grantee rows WITH a token (the emailed redeem link), so the rule
-- becomes: link grants carry a token and no email; user grants carry a token
-- exactly when they are guest grants (email set); internal user grants carry
-- neither.
alter table share_grants drop constraint share_grants_check1;
alter table share_grants add constraint share_grants_token_shape check (
  case
    when grantee_type = 'link' then token_hash is not null and grantee_email is null
    else (grantee_email is not null) = (token_hash is not null)
  end
);

-- Master switch: on by default for free/team; enterprise admins opt in
-- (consulting-firm mode). Off blocks creating AND redeeming guest shares.
alter table organizations
  add column external_sharing boolean not null default true;

update organizations set external_sharing = false where tier = 'enterprise';

-- Cross-org redeem lookup is by token hash; partial index keeps it cheap.
create index share_grants_guest_token_idx
  on share_grants (token_hash)
  where grantee_email is not null;

-- Redeem runs as the provisioner (no tenant context yet — the token IS the
-- identity, same trust boundary as invite acceptance): read-only, by hash.
grant select on share_grants to vorlyn_provisioner;
