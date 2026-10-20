FROM node:22.23.3-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Next's Linux runtime needs no additional system packages on this Node image.
# Consume only reproducible source inputs, never host node_modules or .env files.
COPY package.json package-lock.json ./
COPY packages ./packages
COPY examples/next-app/package.json ./examples/next-app/package.json
RUN npm ci
COPY examples/next-app/app ./examples/next-app/app
COPY examples/next-app/components ./examples/next-app/components
COPY examples/next-app/lib ./examples/next-app/lib
COPY examples/next-app/next.config.ts examples/next-app/next-env.d.ts examples/next-app/tsconfig.json examples/next-app/postcss.config.mjs examples/next-app/eslint.config.mjs ./examples/next-app/
COPY tests/example-smoke.test.ts ./tests/example-smoke.test.ts
RUN npm run build --workspace @flagforge/sdk \
    && npm --prefix examples/next-app test \
    && npm --prefix examples/next-app run typecheck \
    && npm --prefix examples/next-app run build

ENV NODE_ENV=production
EXPOSE 3001
USER node
CMD ["npm", "--prefix", "examples/next-app", "run", "start"]
