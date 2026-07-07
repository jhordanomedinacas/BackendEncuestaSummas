require("dotenv").config();
const app = require("./app");

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`[server] API escuchando en http://localhost:${PORT}`);
});
