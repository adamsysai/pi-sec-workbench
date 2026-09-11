---
description: "Docker and Kubernetes — containerization, orchestration, Helm, manifests, networking"
---
# Docker + Kubernetes

## When to Use

- Writing or optimizing Dockerfiles
- Creating or modifying Kubernetes manifests
- Setting up Helm charts or health checks
- Debugging container or pod issues

## Procedure

1. **Use multi-stage builds** to keep the final image small:
   ```dockerfile
   FROM node:20 AS builder
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci
   COPY . .
   RUN npm run build

   FROM node:20-slim
   WORKDIR /app
   COPY --from=builder /app/dist ./dist
   COPY --from=builder /app/node_modules ./node_modules
   USER node
   CMD ["node", "dist/index.js"]
   ```

2. **Add a `.dockerignore`** — exclude `node_modules`, `.git`, test files, and local env files.

3. **Cache layers** — copy dependency manifests before source code so changes to source don't invalidate the dependency layer.

4. **Run as non-root** — create and switch to a dedicated user:
   ```dockerfile
   RUN useradd -m appuser
   USER appuser
   ```

5. **Use distroless or alpine** base images to reduce attack surface.

6. **Add HEALTHCHECK** so the orchestrator knows the app is ready:
   ```dockerfile
   HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
     CMD curl -f http://localhost:3000/health || exit 1
   ```

7. **Define Kubernetes manifests** with resource limits and probes:
   ```yaml
   spec:
     containers:
     - name: app
       image: registry/app:v1.2.3
       resources:
         requests: { cpu: "100m", memory: "128Mi" }
         limits: { cpu: "500m", memory: "512Mi" }
       livenessProbe:
         httpGet: { path: /health, port: 3000 }
       readinessProbe:
         httpGet: { path: /ready, port: 3000 }
   ```

8. **Use Helm charts** for templated, reusable deployments:
   ```bash
   helm create app-chart
   helm lint app-chart/
   helm template app-chart/ | kubectl apply --dry-run=client -f -
   ```

9. **Separate ConfigMaps from Secrets** — never put credentials in ConfigMaps or image env vars.

10. **Add NetworkPolicies** to restrict pod-to-pod traffic to only required ports.

## Pitfalls

- Building from `latest` tag — always pin exact image tags for reproducibility
- Forgetting `USER` directive — container runs as root
- No `.dockerignore` — builds are slow and images include secrets/local files
- Liveness probe too aggressive — kills pods during slow startup (use readiness for startup, liveness for runtime)
- No resource limits — a single pod can starve the node

## Verification

- `docker build` succeeds and image size is reasonable (`docker images`)
- `docker run` starts and healthcheck passes
- `helm lint` passes
- `kubectl describe pod` shows both probes passing
- `trivy image <image>` reports no high/critical vulnerabilities
- Container runs as non-root (`docker run --rm <image> id -u` returns non-zero)
