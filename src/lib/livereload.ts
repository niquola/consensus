// Live reload via WebSocket — works with bun --hot
// On hot reload, Bun.serve() is replaced → old WS connections drop → browser reconnects → gets new buildId → reloads

export const buildId = Date.now().toString(36);

export const liveReloadWs = {
  open(ws: any) {
    ws.send(buildId);
  },
  message(_ws: any, _msg: any) {},
};

export const liveReloadScript = `<script>
(function() {
  var id = null;
  function connect() {
    var ws = new WebSocket("ws://" + location.host + "/__reload");
    ws.onmessage = function(e) {
      if (id && id !== e.data) location.reload();
      id = e.data;
    };
    ws.onclose = function() {
      setTimeout(connect, 500);
    };
  }
  connect();
})();
</script>`;
