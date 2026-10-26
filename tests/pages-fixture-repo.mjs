// In-memory GitHub HTTP fixture. Never imported into the published app.
export function repositoryFixture(seed = {}) {
  let sequence = 200; const next = () => (++sequence).toString(16).padStart(40, '0');
  const blobs = new Map(), trees = new Map(), commits = new Map(), initial = new Map();
  for (const [name, value] of Object.entries(seed)) { const id = next(); blobs.set(id, typeof value === 'string' ? Buffer.from(value) : value); initial.set(name, id); }
  const treeId = next(); trees.set(treeId, initial); let tip = next(); commits.set(tip, { tree: { sha: treeId }, message: 'initial' });
  const fixture = {
    user: { id: 42, login: 'demo-user' }, write: true, revoked: false, calls: [],
    currentFiles() { return new Map([...trees.get(commits.get(tip).tree.sha)].map(([p, id]) => [p, blobs.get(id)])); },
    marker() {
      const projects = {};
      for (const [p, value] of this.currentFiles()) if (p.startsWith('catalog/')) { const meta = JSON.parse(value.toString()); projects[meta.slug] = meta.uploadId; }
      return { sha: tip, projects };
    },
    bundle(slug) {
      const metadata = this.currentFiles().get(`catalog/${slug}.json`); if (!metadata) return null;
      const meta = JSON.parse(metadata.toString()), files = {};
      for (const [p, value] of this.currentFiles()) if (p.startsWith(`projects/${slug}/`)) files[p.slice(`projects/${slug}/`.length)] = value.toString('base64');
      return { version: 1, slug, uploadId: meta.uploadId, files };
    },
    async fetcher(input, options = {}) {
      const url = new URL(input), route = url.pathname, body = options.body ? JSON.parse(options.body) : undefined;
      this.calls.push({ route, method: options.method || 'GET' });
      const headers = new Headers(options.headers);
      if (headers.get('Authorization') !== 'Bearer fixture-token' || this.revoked) return Response.json({ message: 'Fixture requires its disposable token.' }, { status: 401 });
      if (route === '/user') return Response.json(this.user);
      const root = '/repos/Kintinz/showcase';
      if (route === root) return Response.json({ permissions: { push: this.write } });
      if (options.method && options.method !== 'GET' && !this.write) return Response.json({}, { status: 403 });
      if (route === root + '/git/ref/heads/main') return Response.json({ object: { sha: tip } });
      if (route.startsWith(root + '/git/commits/') && !options.method) return Response.json(commits.get(route.split('/').at(-1)) || {}, { status: commits.has(route.split('/').at(-1)) ? 200 : 404 });
      if (route.startsWith(root + '/git/trees/') && !options.method) return Response.json({ truncated: false, tree: [...trees.get(route.split('/').at(-1))].map(([path, sha]) => ({ path, sha, type: 'blob' })) });
      if (route.startsWith(root + '/git/blobs/') && !options.method) return Response.json({ content: blobs.get(route.split('/').at(-1)).toString('base64') });
      if (route === root + '/git/blobs') { const id = next(); blobs.set(id, Buffer.from(body.content, 'base64')); return Response.json({ sha: id }); }
      if (route === root + '/git/trees') {
        const tree = new Map(trees.get(body.base_tree));
        for (const entry of body.tree) {
          if (entry.sha === null) tree.delete(entry.path);
          else if (entry.content !== undefined) { const id = next(); blobs.set(id, Buffer.from(entry.content)); tree.set(entry.path, id); }
          else tree.set(entry.path, entry.sha);
        }
        const id = next(); trees.set(id, tree); return Response.json({ sha: id });
      }
      if (route === root + '/git/commits') { const id = next(); commits.set(id, { message: body.message, tree: { sha: body.tree }, parents: body.parents }); return Response.json({ sha: id }); }
      if (route === root + '/git/refs/heads/main') {
        if (body.force || commits.get(body.sha).parents[0] !== tip) return Response.json({}, { status: 422 });
        tip = body.sha; return Response.json({ object: { sha: tip } });
      }
      if (route.startsWith(root + '/compare/')) return Response.json({ status: 'ahead' });
      if (route.endsWith('/actions/workflows/pages.yml/runs')) return Response.json({ workflow_runs: [] });
      return Response.json({ message: 'Unknown fixture route' }, { status: 404 });
    },
  };
  fixture.fetcher = fixture.fetcher.bind(fixture); return fixture;
}
