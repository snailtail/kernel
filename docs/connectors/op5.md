# OP5 Monitor connector

One connector per OP5 Monitor (Administration → Connectors → OP5 Monitor). Kernel reads Livestatus through OP5's
HTTP API (`/api/filter/query`) with a read-only user, a page of 1000 rows at a time. It never sends commands:
acknowledging or scheduling downtime from Kernel is not part of the connector.

## 1. A read-only OP5 user

The connector form shows this text (`GET /api/connectors/types/op5/setup?hostgroups_as_services=true` returns the
same):

1. **Manage → Configure → Group rights**: a group `kernel_readers` with only *API: API Status*, *Host: Host View All*,
   *Service: Service View All* and, when host groups are mapped, *Host group: Hostgroup View All*. No API Config,
   API Command, Configuration or command rights.
2. **Manage → Configure → Users**: a local user `kernel` in that group only, with a long random password.
3. In Kernel: the OP5 URL, the user and the password. Add the OP5 server under *private network access* if it is on
   your LAN, and its CA certificate if it uses your own CA. Plain HTTP is refused unless *Plain HTTP (lab only)* is
   ticked.

**Test** counts the hosts. It says whether OP5 refused the password (HTTP 401) or accepted the user without API
rights (HTTP 403). Over the API the credentials can also be a token (`{"token": "…"}`, sent as a bearer token) for
an OP5 behind a proxy that takes one.

## 2. What becomes a CI

| OP5 | CI | Source id | Relationship |
|---|---|---|---|
| Host | *New hosts as* (`virtual_machine` by default) | the host name | |
| Service | `monitoring_check`, named `host / service` | `service/<host>/<service>` | runs on its host |
| Host group (when *host groups as technical services* is on) | `technical_service` | `hostgroup/<name>` | its hosts are part of it |

- **Hosts** keep their address (`ip`), the name as `fqdn` when it has a dot, `alias`, `check_command`, `notes` and
  `notes_url`, if their CI type has those attributes (servers, VMs and network devices do). Their host groups
  always become tags (`hostgroup=linux`).
- **Check commands** are kept by name only (`check_mysql`). Arguments after `!` often carry passwords and are never
  read into Kernel.
- **Custom variables**: only `_OWNER` and the ones the connector names (*custom variables to keep*, e.g. `TEAM`) are
  kept, as tags (`owner=team-web`). Every other variable is left behind. `_CI_ID` with a Kernel ref (`CI000123`)
  joins the host to that CI instead of matching by name.
- Everything kept goes through the sensitive-data scanner. Notes and plugin output that contain a secret are
  redacted.
- `source_url` is the OP5 detail page of the host or service.

Each run is a full snapshot, so hosts and services that OP5 no longer lists go missing after three runs (see
[the lifecycle](README.md)). When the user may not read services or host groups, or a list comes back empty where it
had rows before, those CIs and their relationships are left as they are and the run says so.

## 3. Events (pull)

With *also fetch current HARD problems as alerts* on, each run reports the hosts and services whose latest HARD state
is a problem:

| OP5 state | Severity |
|---|---|
| OK, UP | clear |
| WARNING | warning |
| CRITICAL, DOWN | critical |
| UNKNOWN, UNREACHABLE | major |

- A SOFT state is not reported until OP5 makes it HARD.
- A problem that is gone is no longer reported, and its alert clears on that run. The previous run is the cursor:
  a standing problem stays one alert (its count goes up), and nothing is kept between runs. A problem that comes and
  goes between two runs is not seen by pull; push (below) catches those.
- An **acknowledged** problem is still an alert, with "Acknowledged in OP5." first in the message.
- A host or service in **scheduled downtime** (a service also when its host is) is reported as maintenance. The
  alert is recorded and suppressed ("Maintenance in …"), and no rule opens an incident for it.
- Event rules can name the connector (its name is the alert source) to turn problems into incidents.

## 4. Events (push)

Pull runs every few minutes. For alerts within seconds, let OP5 post its notifications too. There are two ways.

**An OP5 event source (recommended).** Under **Events → Sources**, add a source of kind *OP5 / Naemon* and set its
CMDB source system to the connector's source system (e.g. `OP5`). Kernel maps the states as above, ignores
acknowledgement, flapping and downtime notifications, and refuses notifications older than an hour. Add a
notification command in OP5 (Manage → Configure → Commands) and a contact that uses it for host and service
notifications:

```sh
#!/bin/sh
# /opt/kernel/kernel-notify.sh, called by the notification command as:
#   kernel-notify.sh "$NOTIFICATIONTYPE$" "$HOSTNAME$" "$SERVICEDESC$" "$SERVICESTATE$$HOSTSTATE$" "$SERVICEOUTPUT$$HOSTOUTPUT$"
# (one command for hosts and services: the macros of the other kind are empty). KERNEL_TOKEN comes from a file only
# the monitoring user can read, never from the command line.
KERNEL_TOKEN=$(cat /opt/kernel/token)
/usr/bin/curl -fsS --max-time 10 -X POST "https://kernel.example.com/api/event-hooks/<source id>" \
  -H "X-Kernel-Token: $KERNEL_TOKEN" -H "Content-Type: application/json" \
  --data "$(jq -n --arg type "$1" --arg host "$2" --arg service "$3" --arg state "$4" --arg output "$5" --argjson ts "$(date +%s)" \
    '{notification_type: $type, host_name: $host, service_description: $service, state: $state, output: $output, timestamp: $ts}')"
```

For a host notification `service_description` is empty, and the alert is on the check `host`, as in pull.

**The generic event API.** A script can also post Kernel's own format to `POST /api/events` with an integration
account's token (same arguments as above). It matches the host by name, and does the state mapping itself, with
the same table:

```sh
case "$4" in OK|UP) sev=clear ;; WARNING) sev=warning ;; CRITICAL|DOWN) sev=critical ;; *) sev=major ;; esac
curl -fsS --max-time 10 -X POST https://kernel.example.com/api/events \
  -H "Authorization: Bearer $KERNEL_TOKEN" -H "Content-Type: application/json" \
  --data "$(jq -n --arg host "$2" --arg check "${3:-host}" --arg sev "$sev" --arg msg "$5" \
    '{source: "OP5", events: [{host: $host, check: $check, severity: $sev, message: $msg}]}')"
```

Pushed and pulled alerts have different sources (the event source's name and the connector's name), so they do not
merge. Use one of them for incident rules.
