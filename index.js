require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============================================================
// PERSISTENT STORAGE — เก็บ Config แต่ละ Guild ในไฟล์ JSON
// ============================================================
const CONFIG_FILE = path.join(__dirname, 'guild_configs.json');

function loadConfigs() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function saveConfigs(configs) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
}
function getGuildConfig(guildId) {
  return loadConfigs()[guildId] || null;
}
function setGuildConfig(guildId, config) {
  const configs = loadConfigs();
  configs[guildId] = config;
  saveConfigs(configs);
}

// ============================================================
// STATE
// ============================================================
const pendingVerifications = new Map();

// ============================================================
// DISCORD BOT
// ============================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('ready', () => {
  console.log(`Bot ready: ${client.user.tag}`);
  client.user.setActivity('/verify | playfab auth', { type: 3 });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // /setup_auth
  if (interaction.commandName === 'setup_auth') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ embeds: [errorEmbed('คำสั่งนี้ใช้ได้เฉพาะ Administrator เท่านั้น')], ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const titleId   = interaction.options.getString('title_id');
    const secretKey = interaction.options.getString('secret_key');
    const role      = interaction.options.getRole('role_id');
    const channel   = interaction.options.getChannel('embed_channel');

    try {
      await testPlayFabConnection(titleId, secretKey);
    } catch (err) {
      return interaction.editReply({ embeds: [errorEmbed(`ไม่สามารถเชื่อมต่อ PlayFab ได้\n\`${err.message}\``)] });
    }

    setGuildConfig(interaction.guildId, {
      titleId, secretKey, roleId: role.id, embedChannelId: channel.id,
      setupBy: interaction.user.id, setupAt: new Date().toISOString(),
    });

    const setupEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎮 ระบบยืนยันตัวตน PlayFab พร้อมใช้งานแล้ว!')
      .setDescription('> ยืนยันบัญชี PlayFab ของคุณเพื่อรับสิทธิ์ในเซิร์ฟเวอร์นี้\n\u200b')
      .addFields(
        { name: '📋 วิธีใช้งาน', value: '**1.** พิมพ์คำสั่ง </verify:0> ในช่อง Bot Commands\n**2.** กดลิงก์ที่ Bot ส่งมา\n**3.** กรอกอีเมลและรหัสผ่าน PlayFab\n**4.** รับ Role และการแจ้งเตือนทาง DM ทันที!' },
        { name: '✅ Role ที่จะได้รับ', value: `<@&${role.id}>`, inline: true },
        { name: '🔒 ความปลอดภัย', value: 'ข้อมูลส่งตรงถึง PlayFab เท่านั้น', inline: true }
      )
      .setFooter({ text: `Powered by PlayFab Auth Bot • ${client.user.username}`, iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    try {
      await channel.send({ embeds: [setupEmbed] });
    } catch {
      return interaction.editReply({ embeds: [errorEmbed(`Bot ไม่มีสิทธิ์ส่งข้อความใน <#${channel.id}>`)] });
    }

    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ ตั้งค่าสำเร็จ!')
        .setDescription(`Embed ถูกส่งไปที่ <#${channel.id}> แล้ว`)
        .addFields(
          { name: 'PlayFab Title ID', value: `\`${titleId}\``, inline: true },
          { name: 'Role', value: `<@&${role.id}>`, inline: true },
          { name: 'ช่อง', value: `<#${channel.id}>`, inline: true }
        )],
    });
  }

  // /verify
  if (interaction.commandName === 'verify') {
    const config = getGuildConfig(interaction.guildId);
    if (!config) {
      return interaction.reply({ embeds: [errorEmbed('เซิร์ฟเวอร์นี้ยังไม่ได้ตั้งค่า ให้ Admin ใช้ `/setup_auth` ก่อน')], ephemeral: true });
    }
    if (interaction.member.roles.cache.has(config.roleId)) {
      return interaction.reply({ embeds: [errorEmbed('✅ คุณได้รับการยืนยันแล้ว ไม่ต้องทำซ้ำ')], ephemeral: true });
    }

    const token = uuidv4();
    pendingVerifications.set(token, { discordId: interaction.user.id, guildId: interaction.guildId, createdAt: Date.now() });
    setTimeout(() => pendingVerifications.delete(token), 10 * 60 * 1000);

    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🔐 ยืนยันตัวตน PlayFab')
        .setDescription(`👉 **[คลิกที่นี่เพื่อยืนยัน](${process.env.WEB_URL}/verify?token=${token})**\n\n⏰ ลิงก์จะหมดอายุใน **10 นาที**`)
        .setFooter({ text: '⚠️ อย่าแชร์ลิงก์นี้กับคนอื่นเด็ดขาด' }).setTimestamp()],
      ephemeral: true,
    });
  }
});

// ============================================================
// PLAYFAB HELPERS
// ============================================================
async function testPlayFabConnection(titleId, secretKey) {
  const res = await axios.post(`https://${titleId}.playfabapi.com/Server/GetTitleData`,
    { Keys: ['test'] }, { headers: { 'X-SecretKey': secretKey } }
  );
  if (res.data.code !== 200) throw new Error(res.data.errorMessage || 'Unknown error');
  return true;
}

async function loginWithPlayFab(titleId, email, password) {
  const res = await axios.post(`https://${titleId}.playfabapi.com/Client/LoginWithEmailAddress`, {
    TitleId: titleId, Email: email, Password: password,
    InfoRequestParameters: { GetUserAccountInfo: true },
  });
  return res.data;
}

// ============================================================
// EXPRESS
// ============================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/verify', (req, res) => {
  const { token } = req.query;
  if (!token || !pendingVerifications.has(token)) return res.send(renderError('ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว'));
  res.send(renderLoginPage(token));
});

app.post('/verify', async (req, res) => {
  const { token, email, password } = req.body;
  const session = pendingVerifications.get(token);
  if (!session) return res.send(renderError('ลิงก์หมดอายุแล้ว'));

  const config = getGuildConfig(session.guildId);
  if (!config) return res.send(renderError('ไม่พบ Config ของเซิร์ฟเวอร์'));

  try {
    const pfResult    = await loginWithPlayFab(config.titleId, email, password);
    const accountInfo = pfResult.data.InfoResultPayload.AccountInfo;
    const PlayFabId   = accountInfo.PlayFabId;
    const displayName = accountInfo.TitleInfo?.DisplayName || accountInfo.Username || email.split('@')[0];

    const guild  = await client.guilds.fetch(session.guildId);
    const member = await guild.members.fetch(session.discordId);
    const role   = guild.roles.cache.get(config.roleId);
    if (role) await member.roles.add(role);

    const discordUser = await client.users.fetch(session.discordId);
    await discordUser.send({
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ ยืนยันตัวตนสำเร็จ!')
        .setDescription(`ยินดีต้อนรับสู่ **${guild.name}**! 🎉`)
        .addFields(
          { name: '👤 ชื่อในเกม',    value: `\`${displayName}\``, inline: true },
          { name: '🆔 PlayFab ID',   value: `\`${PlayFabId}\``,   inline: true },
          { name: '🏆 Role ที่ได้รับ', value: role ? `\`${role.name}\`` : '-', inline: true }
        )
        .setFooter({ text: `${guild.name} • Powered by PlayFab Auth`, iconURL: guild.iconURL() })
        .setTimestamp()],
    });

    pendingVerifications.delete(token);
    res.send(renderSuccess(displayName, PlayFabId, guild.name));
  } catch (err) {
    const errMsg = err?.response?.data?.errorMessage || 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
    res.send(renderError(errMsg, token));
  }
});

// ============================================================
// HTML
// ============================================================
function renderLoginPage(token) {
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ยืนยันตัวตน PlayFab</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:rgba(255,255,255,.05);backdrop-filter:blur(20px);border-radius:20px;padding:44px 40px;width:400px;border:1px solid rgba(255,255,255,.1);box-shadow:0 20px 60px rgba(0,0,0,.5)}
.logo{font-size:52px;text-align:center;margin-bottom:10px}h1{color:#fff;text-align:center;font-size:22px;font-weight:700;margin-bottom:4px}.subtitle{color:rgba(255,255,255,.5);text-align:center;font-size:13px;margin-bottom:32px}
.field{margin-bottom:18px}label{display:block;color:rgba(255,255,255,.7);font-size:12px;font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}
input{width:100%;padding:13px 16px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.07);color:#fff;font-size:15px;font-family:'Inter',sans-serif;transition:border .2s,background .2s}
input::placeholder{color:rgba(255,255,255,.25)}input:focus{outline:none;border-color:#5865f2;background:rgba(88,101,242,.1)}
button{width:100%;padding:14px;background:linear-gradient(135deg,#5865f2,#4752c4);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;font-family:'Inter',sans-serif;cursor:pointer;margin-top:8px;box-shadow:0 4px 20px rgba(88,101,242,.4)}
button:hover{opacity:.9}hr{border:none;border-top:1px solid rgba(255,255,255,.08);margin:24px 0}.warning{color:rgba(255,255,255,.3);font-size:11px;text-align:center;line-height:1.7}.warning span{color:rgba(255,255,255,.5)}</style></head>
<body><div class="card"><div class="logo">🎮</div><h1>ยืนยันบัญชี PlayFab</h1><p class="subtitle">กรอกข้อมูลเพื่อรับสิทธิ์ใน Discord Server</p>
<form method="POST" action="/verify"><input type="hidden" name="token" value="${token}">
<div class="field"><label>อีเมล</label><input type="email" name="email" placeholder="example@email.com" required></div>
<div class="field"><label>รหัสผ่าน</label><input type="password" name="password" placeholder="••••••••" required></div>
<button type="submit">🔐 ยืนยันตัวตน</button></form>
<hr><p class="warning"><span>🔒 ปลอดภัย 100%</span><br>ข้อมูลส่งตรงถึง PlayFab เท่านั้น ไม่มีการบันทึกรหัสผ่าน</p></div></body></html>`;
}

function renderSuccess(displayName, playfabId, guildName) {
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>สำเร็จ!</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#0f2027,#203a43,#2c5364);min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:rgba(255,255,255,.05);backdrop-filter:blur(20px);border-radius:20px;padding:44px 40px;width:400px;text-align:center;border:1px solid rgba(87,242,135,.2);box-shadow:0 20px 60px rgba(0,0,0,.5)}
.icon{font-size:64px;margin-bottom:16px;animation:pop .5s ease}@keyframes pop{0%{transform:scale(0)}80%{transform:scale(1.1)}100%{transform:scale(1)}}
.badge{display:inline-block;background:rgba(87,242,135,.15);color:#57f287;border-radius:20px;padding:4px 14px;font-size:12px;font-weight:600;margin-bottom:16px;border:1px solid rgba(87,242,135,.3)}
h1{color:#57f287;font-size:24px;font-weight:700;margin-bottom:8px}.subtitle{color:rgba(255,255,255,.5);font-size:14px;margin-bottom:28px}
.info-grid{display:grid;gap:12px;margin-bottom:8px}.info-box{background:rgba(255,255,255,.07);border-radius:12px;padding:14px 18px;text-align:left;border:1px solid rgba(255,255,255,.08)}
.info-label{color:rgba(255,255,255,.4);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}.info-value{color:#fff;font-size:16px;font-weight:600;margin-top:4px}
.close-note{color:rgba(255,255,255,.2);font-size:12px;margin-top:24px}</style></head>
<body><div class="card"><div class="icon">✅</div><div class="badge">✔ Verified</div><h1>ยืนยันตัวตนสำเร็จ!</h1>
<p class="subtitle">คุณได้รับสิทธิ์ใน <strong>${guildName}</strong> แล้ว ตรวจสอบ DM 📬</p>
<div class="info-grid"><div class="info-box"><div class="info-label">👤 ชื่อในเกม</div><div class="info-value">${displayName}</div></div>
<div class="info-box"><div class="info-label">🆔 PlayFab ID</div><div class="info-value">${playfabId}</div></div></div>
<p class="close-note">สามารถปิดหน้าต่างนี้ได้แล้ว 🎉</p></div></body></html>`;
}

function renderError(message, token = null) {
  const btn = token ? `<a href="/verify?token=${token}" class="btn">🔄 ลองอีกครั้ง</a>` : '';
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>เกิดข้อผิดพลาด</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#200122,#6f0000);min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:rgba(255,255,255,.05);backdrop-filter:blur(20px);border-radius:20px;padding:44px 40px;width:400px;text-align:center;border:1px solid rgba(237,66,69,.3)}
.icon{font-size:60px;margin-bottom:16px}h1{color:#ed4245;font-size:22px;font-weight:700;margin-bottom:12px}p{color:rgba(255,255,255,.6);font-size:14px;margin-bottom:24px;line-height:1.6}
.btn{display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#5865f2,#4752c4);color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:600}</style></head>
<body><div class="card"><div class="icon">❌</div><h1>เกิดข้อผิดพลาด</h1><p>${message}</p>${btn}</div></body></html>`;
}

function errorEmbed(desc) {
  return new EmbedBuilder().setColor(0xed4245).setDescription(desc);
}

// ============================================================
// REGISTER COMMANDS
// ============================================================
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = [
    new SlashCommandBuilder()
      .setName('setup_auth')
      .setDescription('ตั้งค่าระบบยืนยันตัวตน PlayFab')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(o => o.setName('title_id').setDescription('PlayFab Title ID').setRequired(true))
      .addStringOption(o => o.setName('secret_key').setDescription('PlayFab Secret Key').setRequired(true))
      .addRoleOption(o => o.setName('role_id').setDescription('Role ที่จะให้เมื่อยืนยันสำเร็จ').setRequired(true))
      .addChannelOption(o => o.setName('embed_channel').setDescription('ช่องที่จะส่ง Embed').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('ยืนยันตัวตนด้วยบัญชี PlayFab')
      .toJSON(),
  ];
  try {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
    console.log('Slash Commands registered (Global)');
  } catch (err) {
    console.error('Register failed:', err);
  }
}

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web Server running at http://localhost:${PORT}`));
client.login(process.env.DISCORD_TOKEN);
registerCommands();

