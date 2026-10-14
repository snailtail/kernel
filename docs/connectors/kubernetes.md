# Kubernetes connector

One connector per cluster (Administration → Connectors → Kubernetes cluster). Kernel reads the API server with a
read-only ServiceAccount token and turns the cluster, its nodes, namespaces and workloads (Deployment, StatefulSet,
DaemonSet, CronJob) into CIs. Pods are not CIs; each workload carries its desired and ready replicas instead.

Kernel never reads Secrets, ConfigMaps, environment variables, arguments or annotations, and the role below does not
allow it to.

## 1. A read-only ServiceAccount

Apply this in the cluster (`kubectl apply -f kernel-reader.yaml`). It grants `get` and `list` on exactly the kinds the
connector reads, and nothing else: no `watch`, no pods, no Secrets.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: kernel
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kernel-reader
  namespace: kernel
automountServiceAccountToken: false
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kernel-reader
rules:
  - apiGroups: [""]
    resources: ["nodes", "namespaces"]
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets"]
    verbs: ["get", "list"]
  - apiGroups: ["batch"]
    resources: ["cronjobs"]
    verbs: ["get", "list"]
  # Only if "Warning events as alerts" is switched on:
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kernel-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kernel-reader
subjects:
  - kind: ServiceAccount
    name: kernel-reader
    namespace: kernel
```

Leave out the `events` rule when you do not sync events. A kind the role forbids is reported on the run ("forbidden by
the ServiceAccount's role"); its CIs and relationships are left as they are, while every kind that was read completely
is synced as usual (deleted objects count as missed).

## 2. A token

Either a long-lived token stored as a Secret (rotate it by deleting and re-creating the Secret):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: kernel-reader-token
  namespace: kernel
  annotations:
    kubernetes.io/service-account.name: kernel-reader
type: kubernetes.io/service-account-token
```

```sh
kubectl -n kernel get secret kernel-reader-token -o jsonpath='{.data.token}' | base64 -d
```

or a time-bound token, which you then have to replace in Kernel before it expires:

```sh
kubectl -n kernel create token kernel-reader --duration=2160h
```

## 3. The API server and its CA

```sh
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'
kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d
```

Paste the server URL (https only), the PEM certificate and the token into the connector form. The token is encrypted
and never shown again. If the API server has a private address, add it to the connector's allowed private addresses.
**Test connection** reports the Kubernetes version and the node count.

## What ends up in the CMDB

| CI type | Source id | Kept |
|---|---|---|
| `cluster` | `cluster` | platform, Kubernetes version |
| node (`virtual_machine` by default) | `node/<name>` | OS image, kubelet version, internal IP, CPU and memory, `resource_id` or `bios_uuid` from `providerID` |
| `kubernetes_namespace` | `ns/<name>` | allowlisted labels |
| `kubernetes_workload` | `<Kind>/<namespace>/<name>` | kind, namespace, image names, desired/ready replicas, CronJob schedule, allowlisted labels |

`kube-system`, `kube-public` and `kube-node-lease` are left out by default (no CIs, workloads or alerts); change the
list under **Leave out namespaces**. A namespace added to the list after it was synced is no longer reported, so it
and its workloads count as missed and become `missing` after three runs (they are never deleted).

Labels kept as tags: `app.kubernetes.io/*` and the optional owner label. Nodes on Azure, AWS, GCE or vSphere carry
the VM's id, so the CMDB joins them to the VM another connector reports. Relationships: the cluster contains its
namespaces and nodes, a namespace contains its workloads.

## Alerts

With **Warning events as alerts**, crash loops, out-of-memory kills, scheduling and mount failures and failing probes
become one alert per workload and reason. Only events seen within two sync intervals count (Kubernetes keeps events
for an hour after the problem is gone), so a fixed crash loop clears on the next run. A pod is matched to its workload
by its name's form (`<deployment>-<hash>-<id>`, `<statefulset>-<n>`, `<daemonset>-<id>`); other pods, like a
standalone Job's, raise no alert.

For Prometheus, create an event source of kind `alertmanager` under Events → Sources and point Alertmanager's webhook
receiver at its URL (`/api/event-hooks/<id>`); see the README's table of event sources.
