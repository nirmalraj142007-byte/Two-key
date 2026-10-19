# Spike results

Appended by `npm run spike:vault` and `npm run spike:honor`. Vault and payment-token IDs are never written here.

## Vault spike — 2026-10-19T13:55:07.583Z (run `20261019135507-d68b`)

| Step | Result | Detail |
| --- | --- | --- |
| a | OK | setup token 8BT56954EU506071A status PAYER_ACTION_REQUIRED |
| b | FAIL | not APPROVED within 5 minutes (statuses seen: PAYER_ACTION_REQUIRED) |
| d | FAIL | skipped: no vaulted payment token |
| e | FAIL | skipped: no vaulted payment token |
| f | FAIL | skipped: no vaulted payment token |
| g | FAIL | skipped: no vaulted payment token |

- Honor-period authorization: none
- LADDER_A_FAILED: not run
- **NO-GO: no vaulted payment token**

## Vault spike — 2026-10-19T14:01:02.069Z (run `20261019140102-5b57`)

| Step | Result | Detail |
| --- | --- | --- |
| a | OK | setup token 35X11212KF594584R status PAYER_ACTION_REQUIRED |
| b | OK | setup token APPROVED (statuses seen: PAYER_ACTION_REQUIRED -> APPROVED) |
| c | OK | payment token created (customer present); saved to spikes/results/vault.json |
| d | OK | order A 21P1158010424021J COMPLETED; authorization 0X533610ER475260E CREATED |
| d | OK | capture 9B960828VW625451S COMPLETED |
| d | OK | replay with same PayPal-Request-Id -> order 21P1158010424021J (same order) |
| e | OK | order B 69G46974GB838033L COMPLETED; authorization 5E990482LF9493607 CREATED |
| e | OK | void -> authorization status VOIDED |
| f | OK | order C 0SP17637BH721754V payee Stride Supply; authorization 3ST26804A6874654P CREATED |
| f | OK | capture 4J1226984K781532W COMPLETED |
| g | OK | order D 1LP61304B8947721W; authorization 93927348PL797874L CREATED (expires 2026-11-17T14:07:27Z); saved to spikes/results/honor.json |

- Honor-period authorization: 93927348PL797874L
- LADDER_A_OK
- **GO**
