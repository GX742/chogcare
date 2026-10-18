# Сервер платежей ChogCare

Выбран VDSina Standard, Amsterdam: 1 vCPU, 1 GB RAM, 10 GB NVMe,
$0.07/day ($2.10 за 30 дней), без годового обязательства.
Криптопополнение начинается от $20; это аванс на баланс, не месячная цена.
Окончательную сумму, сеть криптоплатежа и наличие тарифа проверяют в биллинге.

Источники, проверены 16.10.2026:
- https://www.vdsina.com/pricing/standard
- https://www.vdsina.com/ru/qa/q/perevod-sredstv-s-akkaunta-ru-na-com

## Границы переноса

На VPS работают Node API, CHOG/NFT обработчики и приватные SQLite.
Сайт остаётся на Vercel. Камера/OBS и COM6 остаются у физической станции.
Новый сервер не должен запускать вторую копию подписанта параллельно старой.
Перед включением VPS старый Payments должен быть полностью остановлен.

## Изменения обработки

- Отправка каждого source transaction сохраняется до broadcast, как раньше.
- После broadcast обработчик до 1.2 s читает квитанцию того же hash и может
  перейти к следующему этапу в том же цикле. Повторная подпись/замена nonce
  не допускается. Неподтверждённая source-транзакция следующий этап не разрешает.
- Отдельный track() продолжает чтение destination receipts, пока другой
  инвойс занимает source signer. Один инвойс не обрабатывается одновременно.
- Ограничение PublicNode на archive reads переключает чтение на проверенный
  резервный RPC. Настоящие reverts/invalid params не превращаются в успех.
- Received/confirming показывается только после проверки реального получателя,
  токена, суммы и canonical block. Delivered остаётся отдельной финальностью.

Цель 30 s относится к приходу обычного платежа; SLA на любой перевод нет.
Финальность Optimism не ускоряется сменой сервера. Предварительное кредитование
из резерва, объединение пользовательских средств и новые финансовые маршруты
этим обновлением не вводятся.

## Подготовленный пакет

`node scripts/package-payment-server.mjs` создаёт code-only tar.gz в
`work/server-release/`. В пакете только runtime-код и зависимости ethers/viem;
нет React, Electron, firmware, .env, баз, ключей и платёжной истории.
При установленном lockfile используется `npm ci --omit=dev --ignore-scripts`.
Сборку интерфейса и npm frontend build на VPS выполнять не требуется.

Требования: Ubuntu 24.04 x86_64, Node.js 24.22+ LTS (только 24.x; node:sqlite и
встроенный TypeScript), systemd с LoadCredentialEncrypted, nginx, SSH key.
Для 1 GB настроить 1 GB swap и ограничение журнала; не запускать OBS/транскодинг.

## Развёртывание после получения SSH-доступа

1. Установить Node из официального дистрибутива с проверкой SHA256, nginx и
   сертификат для api.chogcare.xyz. Разрешить снаружи только SSH/HTTPS.
2. Создать системного пользователя chogcare без shell-входа. Код разместить
   root-owned в /opt/chogcare-payments; установить runtime зависимости.
   Приватное состояние хранить в /var/lib/chogcare/work, owner chogcare,
   каталоги 0700, файлы 0600. API и lease слушают только 127.0.0.1:4174/4175.
3. Остановить Payments на старом компьютере, не останавливая COM6/стрим.
   Проверить исходный checkpoint штатным `scripts/payment-integrity.mjs --check`.
   Снять SQLite backup обеих баз, включая WAL, и сохранить зашифрованный vault.
   Не копировать один активный .sqlite без WAL.
4. По SSH перенести существующие processor.sqlite, preview.sqlite и encrypted
   custody/vault.json в соответствующие пути /var/lib/chogcare/work/payments.
   Старый checkpoint перенести как integrity/checkpoint.source.json.
   Оригиналы и локальный backup сохраняются.
5. На VPS от пользователя chogcare, cwd /var/lib/chogcare, выполнить:
   `/usr/bin/node /opt/chogcare-payments/scripts/relocate-payment-checkpoint.mjs --verify-relocation`.
   Команда проверяет обе базы по старому digest, записывает новый checkpoint
   только при совпадении истории и отсутствии целевого checkpoint. Она не
   создаёт новые адреса, не меняет строки/nonce и не читает vault.
   При несовпадении остановиться; не запускать --enroll для обхода ошибки.
6. В своём SSH-терминале от root создать /etc/credstore.encrypted с mode 0700,
   затем ввести существующий пароль только в локальном скрытом запросе:

   ```sh
   systemd-ask-password 'Existing custody password:' | systemd-creds encrypt --name=custody-password - /etc/credstore.encrypted/chogcare-custody
   ```

   Пароль не передаётся в argv, environment, chat или plaintext-файл. systemd
   расшифрует credential в приватный read-only /run каталог при запуске.
   Это позволяет запуск после перезагрузки; администратор VPS остаётся частью
   доверенной границы хранения ключей.
7. Установить `ops/payments/chogcare-payments.service` в /etc/systemd/system.
   Проверить unit через systemd-analyze verify, nginx через nginx -t, затем
   включить chogcare-payments.service. Первый запуск может продолжить ранее
   подписанные операции; никаких тестовых оплат для проверки не требуется.
8. Проверить локальный config и сохранённые инвойсы только чтением, MON для
   служебного газа и USDC/ETH NFT treasury. Недостаток газа нельзя лечить
   подменой readiness=true: нужен реальный резерв оператора.
9. После проверки HTTPS поменять только Vercel rewrite `/api/payments/:path*`
   на `https://api.chogcare.xyz/api/payments/:path*`, опубликовать сайт и
   сверить config/версии/состояния. Проверить перезагрузку VPS.

## Восстановление

Автоперезапуск systemd возобновляет существующие hash/nonce. Он не лечит
несовпадение checkpoint, исчерпанный баланс и сбой внешних сетей.
Для отката сначала полностью остановить VPS-подписант. Не запускать старую
локальную базу после новых облачных переводов: сначала вернуть актуальную
пару баз/checkpoint и проверить целостность и историю блокчейна.
Зашифрованные копии баз, checkpoint и vault хранить вне VPS; стандартный
снимок VPS не заменяет независимую резервную копию платёжного состояния.
