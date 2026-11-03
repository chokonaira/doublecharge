# The same checks the README asks for, on a pinned Node, with no key and at no cost:
#   docker build -t doublecharge . && docker run --rm doublecharge
# That typechecks, runs every test, audits the grader and re-derives every published verdict.
# Any npm script runs the same way, for example a paid run with a key and the results kept outside:
#   docker run --rm -e OPENROUTER_API_KEY -v "$PWD/runs:/app/runs" doublecharge npm run eval -- --trials 3
FROM node:22.22.3-slim
# git: a run records its commit, and the provenance tests make small repositories of their own.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
CMD ["sh", "-c", "npm run check && npm run reproduce"]
