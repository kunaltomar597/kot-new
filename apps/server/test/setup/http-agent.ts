import http from 'node:http';

// A fresh connection for every request: a pooled keep-alive socket can be reused at the moment the
// app's server times it out (5 s idle), which a busy machine turns into "socket hang up".
http.globalAgent = new http.Agent({ keepAlive: false });
