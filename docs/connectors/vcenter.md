# VMware vCenter connector

One connector per vCenter Server (Administration → Connectors → VMware vCenter). Kernel reads the vSphere Automation
REST API (`/api`, vSphere 7.0 U2 and later) with a read-only user. Each run and each **Test** opens a session
(`POST /api/session`) and deletes it again afterwards (`DELETE /api/session`), so no session is left counting
against vCenter's limit. Kernel never powers, snapshots, migrates or changes anything.

## 1. A read-only vCenter user

The connector form shows this text (`GET /api/connectors/types/vcenter/setup?include_datastores=true` returns the
same):

1. **Administration → Single Sign On → Users and Groups**: a user `kernel` in `vsphere.local` (or a directory
   account) with a long random password.
2. **Administration → Access Control → Roles**: the built-in role *Read-only* (System.Anonymous, System.Read,
   System.View). With datastores on, clone it as *Kernel reader* and add only *Datastore → Browse datastore*. No
   power, snapshot, configuration or alarm privileges.
3. **Inventory**: select the vCenter Server itself (the root), **Permissions → Add**: the user, the role, and tick
   *Propagate to children*. A permission lower in the tree shows Kernel only that part of the estate.
4. In Kernel: the vCenter URL, the user (`kernel@vsphere.local`) and the password. Add the vCenter under *private
   network access* if it is on your LAN, and its CA certificate (vSphere Client → *Download trusted root CA
   certificates*) when it uses the VMCA or your own CA. Plain HTTP is refused unless *Plain HTTP (lab only)* is
   ticked.
5. Optional: the vCenter's **instance UUID**, for links straight to each object. Select the vCenter itself in the
   vSphere Client; the address bar ends in `…/urn:vmomi:Folder:group-d1:<UUID>/summary`.

**Test** counts the datacenters and hosts. It says whether vCenter refused the password (HTTP 401) or accepted the
user without read access to the inventory (HTTP 403).

## 2. What becomes a CI

| vCenter | CI | Source id | Relationship |
|---|---|---|---|
| Datacenter | `datacenter` | `datacenter/<moid>` | contains its clusters and standalone hosts |
| Cluster | `cluster` | `cluster/<moid>` | contains its hosts |
| ESXi host | `physical_server` | `host/<moid>` | |
| VM | `virtual_machine` | `vm/<moid>` | runs on its host; depends on its datastores |
| Datastore (when *datastores* is on) | `storage` | `datastore/<moid>` | |

- **VMs** keep `bios_uuid` (lower case), `instance_uuid`, the guest OS, `cpu`, `ram_gb`, `power_state`, `host`,
  `cluster`, `folder` and `resource_pool`.
- **The BIOS UUID** is what joins a VM to the same machine from another source. A Kubernetes node on vSphere reports
  `providerID: vsphere://<BIOS UUID>`, so the [Kubernetes connector](kubernetes.md)'s node and the vCenter VM become
  one CI, whichever connector runs first. A VM matched that way gets its vSphere tags from its next run on.
- **IP address and host name** come only from VMware Tools (`/guest/identity`): the primary IP as `ip`, the guest's
  host name as `fqdn` when it has a dot, and the OS name the guest reports. With Tools not running, or the VM
  powered off, they are not set (and what was known before stays); the OS is then the configured guest OS.
- **Hosts** keep `connection_state`, `power_state` and `cluster`, and their name as `fqdn` (or as `ip` when they
  were added by address).
- **Clusters** keep whether HA and DRS are on. **Datastores** keep their filesystem (VMFS, NFS, vSAN), capacity and
  free space in TB.
- **vSphere tags** become tags `category=name` (`team=payments`) on the objects they are attached to, when *vSphere
  tags as tags* is on. VM notes and custom attributes are never read (the REST API does not serve custom
  attributes). Everything kept goes through the sensitive-data scanner.
- `source_url` is the vSphere Client's page for the object, e.g.
  `https://vc/ui/app/vm;nav=v/urn:vmomi:VirtualMachine:vm-42:<vCenter UUID>/summary`. Without the instance UUID it
  opens the vSphere Client.

VMs are listed per host, which is also how Kernel knows where each one runs: after a vMotion the next run moves the
*runs on* relationship. Each run is a full snapshot, so objects vCenter no longer lists go missing after three runs
(see [the lifecycle](README.md)). When the user may not read a list (clusters, hosts, VMs, datastores), or a list
comes back empty where it had objects before, those CIs and their relationships are left as they are and the run
says so. Folders, resource pools and tags that cannot be read are left as they were.

## 3. Events

Not yet: the REST API does not list triggered alarms or a host's maintenance mode (they are in the SOAP API only).
Alarms as alerts, with maintenance mode suppressing incidents, are #258. Until then, a script run by a vCenter alarm
action can post to `POST /api/events` with the VM or host name as `host`, as described for OP5 under
[the generic event API](op5.md#4-events-push).
