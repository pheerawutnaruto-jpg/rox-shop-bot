
require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  entersState
} = require('@discordjs/voice');

const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const http = require('http');
const songs = require('./songs.json');

// ==============================
// CONFIGURATION
// ==============================

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  throw new Error('กรุณากำหนด BOT_TOKEN ในไฟล์ .env');
}

if (!ffmpegPath) {
  throw new Error('ไม่พบ FFmpeg กรุณาตรวจสอบ ffmpeg-static');
}

// ==============================
// DISCORD CLIENT
// ==============================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// แยกเครื่องเล่นตามเซิร์ฟเวอร์
const guildPlayers = new Map();

// ==============================
// AUDIO SYSTEM
// ==============================

function getGuildState(guildId) {
  let state = guildPlayers.get(guildId);

  if (!state) {
    const player = createAudioPlayer();

    state = {
      player,
      connection: null,
      ffmpeg: null,
      currentSong: null
    };

    player.on('error', error => {
      console.error(
        `[${guildId}] Audio Player Error:`,
        error.message
      );

      if (state.ffmpeg) {
        state.ffmpeg.kill('SIGKILL');
        state.ffmpeg = null;
      }

      state.currentSong = null;
    });

    player.on('stateChange', (oldState, newState) => {
      console.log(
        `[${guildId}] Player: ${oldState.status} -> ${newState.status}`
      );
    });

    player.on(AudioPlayerStatus.Idle, () => {
      console.log(`[${guildId}] เพลงจบแล้ว`);

      if (state.ffmpeg) {
        state.ffmpeg.kill('SIGKILL');
        state.ffmpeg = null;
      }

      state.currentSong = null;
    });

    guildPlayers.set(guildId, state);
  }

  return state;
}

function stopFFmpeg(state) {
  if (state.ffmpeg) {
    state.ffmpeg.kill('SIGKILL');
    state.ffmpeg = null;
  }
}

function stopMusic(state) {
  state.player.stop();
  stopFFmpeg(state);
  state.currentSong = null;
}

function isValidSongURL(url) {
  try {
    const parsed = new URL(url);

    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'files.catbox.moe'
    );
  } catch {
    return false;
  }
}

// ==============================
// PLAY SONG
// ==============================

async function playSong(interaction, songId) {
  const song = songs[songId];

  if (!song) {
    throw new Error('ไม่พบเพลงที่เลือก');
  }

  if (!isValidSongURL(song.file)) {
    throw new Error('URL เพลงไม่ถูกต้อง หรือไม่ใช่ Catbox HTTPS');
  }

  const voiceChannel = interaction.member.voice.channel;

  if (!voiceChannel) {
    throw new Error('กรุณาเข้าห้องเสียงก่อนเลือกเพลง');
  }

  const guildId = interaction.guild.id;
  const state = getGuildState(guildId);

  // หยุดเพลงเก่าก่อน
  stopMusic(state);

  // เชื่อมต่อห้องเสียง
  if (
    !state.connection ||
    state.connection.state.status === VoiceConnectionStatus.Destroyed
  ) {
    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    state.connection.on('error', error => {
      console.error(`[${guildId}] Voice Error:`, error);
    });
  } else if (
    state.connection.joinConfig.channelId !== voiceChannel.id
  ) {
    state.connection.destroy();

    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    state.connection.on('error', error => {
      console.error(`[${guildId}] Voice Error:`, error);
    });
  }

  await entersState(
    state.connection,
    VoiceConnectionStatus.Ready,
    20_000
  );

  state.connection.subscribe(state.player);

  // FFmpeg URL Streaming
  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'warning',

    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',

    '-i', song.file,

    '-vn',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',

    'pipe:1'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  state.ffmpeg = ffmpeg;
  state.currentSong = song.name;

  let ffmpegError = '';

  ffmpeg.stderr.on('data', data => {
    ffmpegError += data.toString();

    if (ffmpegError.length > 4000) {
      ffmpegError = ffmpegError.slice(-4000);
    }
  });

  ffmpeg.on('error', error => {
    console.error(`[${guildId}] FFmpeg Error:`, error);

    if (state.ffmpeg === ffmpeg) {
      state.ffmpeg = null;
      state.currentSong = null;
      state.player.stop();
    }
  });

  ffmpeg.on('close', (code, signal) => {
    console.log(
      `[${guildId}] FFmpeg closed: code=${code}, signal=${signal}`
    );

    if (code !== 0 && code !== null) {
      console.error('FFmpeg details:', ffmpegError);
    }

    if (state.ffmpeg === ffmpeg) {
      state.ffmpeg = null;
    }
  });

  // แปลง PCM เป็น Discord Audio Resource
  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw
  });

  state.player.play(resource);

  return song;
}

// ==============================
// SLASH COMMAND
// ==============================

client.once('ready', async () => {
  console.log('================================');
  console.log('📻 BOOMBOX V2 ONLINE');
  console.log(`🤖 Bot: ${client.user.tag}`);
  console.log('================================');

  const command = new SlashCommandBuilder()
    .setName('boombox')
    .setDescription('เปิดแผงควบคุม Boombox');

  try {
    await client.application.commands.create(command);
    console.log('Slash Command Registered!');
  } catch (error) {
    console.error('Command Error:', error);
  }
});

// ==============================
// INTERACTIONS
// ==============================

client.on('interactionCreate', async interaction => {
  if (!interaction.guild) return;

  try {

    // --------------------------
    // /boombox
    // --------------------------

    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === 'boombox'
    ) {
      const voiceChannel = interaction.member.voice.channel;

      if (!voiceChannel) {
        return interaction.reply({
          content: '⚠️ กรุณาเข้าห้องเสียงก่อนเปิด Boombox',
          flags: MessageFlags.Ephemeral
        });
      }

      const songEntries = Object.entries(songs).slice(0, 25);

      if (songEntries.length === 0) {
        return interaction.reply({
          content: '⚠️ ยังไม่มีเพลงใน songs.json',
          flags: MessageFlags.Ephemeral
        });
      }

      const options = songEntries.map(([id, song]) => {
        return new StringSelectMenuOptionBuilder()
          .setLabel(song.name.slice(0, 100))
          .setDescription(`รหัสเพลง: ${id}`)
          .setValue(id);
      });

      const selectRow = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('v2_select_song')
            .setPlaceholder('🎧 เลือกเพลงจาก Boombox')
            .addOptions(options)
        );

      const buttonRow = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('v2_pause')
            .setLabel('Pause / Resume')
            .setEmoji('⏯️')
            .setStyle(ButtonStyle.Secondary),

          new ButtonBuilder()
            .setCustomId('v2_stop')
            .setLabel('Stop')
            .setEmoji('⏹️')
            .setStyle(ButtonStyle.Danger)
        );

      const container = new ContainerBuilder()
        .setAccentColor(0x1DB954)
        .addTextDisplayComponents(
          new TextDisplayBuilder()
            .setContent(
              '## 📻 BOOMBOX V2\n' +
              'ระบบเครื่องเล่นเพลง Discord\n\n' +
              '🎵 เลือกเพลงจากรายการด้านล่าง\n' +
              '⏯️ Pause / Resume เพื่อควบคุมเพลง\n' +
              '⏹️ Stop เพื่อหยุดเล่นเพลง'
            )
        )
        .addSeparatorComponents(
          new SeparatorBuilder()
            .setDivider(true)
            .setSpacing(SeparatorSpacingSize.Large)
        )
        .addActionRowComponents(selectRow)
        .addActionRowComponents(buttonRow);

      return interaction.reply({
        components: [container],
        flags: MessageFlags.IsComponentsV2
      });
    }

    // --------------------------
    // SELECT SONG
    // --------------------------

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === 'v2_select_song'
    ) {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      const songId = interaction.values[0];

      try {
        const song = await playSong(interaction, songId);

        return interaction.editReply({
          content: `🎶 กำลังเล่นเพลง **${song.name}**`
        });

      } catch (error) {
        console.error('Play Song Error:', error);

        const state = guildPlayers.get(interaction.guild.id);

        if (state) {
          stopMusic(state);
        }

        return interaction.editReply({
          content: `⚠️ เล่นเพลงไม่สำเร็จ: ${error.message}`
        });
      }
    }

    // --------------------------
    // BUTTONS
    // --------------------------

    if (interaction.isButton()) {
      const state = guildPlayers.get(interaction.guild.id);

      if (!state) {
        return interaction.reply({
          content: '⚠️ ยังไม่มีเครื่องเล่นเพลง',
          flags: MessageFlags.Ephemeral
        });
      }

      if (interaction.customId === 'v2_pause') {
        const status = state.player.state.status;

        if (status === AudioPlayerStatus.Playing) {
          state.player.pause();

          return interaction.reply({
            content: '⏸️ พักเพลงแล้ว',
            flags: MessageFlags.Ephemeral
          });
        }

        if (status === AudioPlayerStatus.Paused) {
          state.player.unpause();

          return interaction.reply({
            content: '▶️ เล่นเพลงต่อแล้ว',
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.reply({
          content: '⚠️ ไม่มีเพลงกำลังเล่น',
          flags: MessageFlags.Ephemeral
        });
      }

      if (interaction.customId === 'v2_stop') {
        stopMusic(state);

        if (state.connection) {
          state.connection.destroy();
          state.connection = null;
        }

        return interaction.reply({
          content: '⏹️ หยุดเพลงและออกจากห้องเสียงแล้ว',
          flags: MessageFlags.Ephemeral
        });
      }
    }

  } catch (error) {
    console.error('Interaction Error:', error);

    const message = {
      content: '⚠️ เกิดข้อผิดพลาดภายในระบบ Boombox'
    };

    if (interaction.deferred) {
      await interaction.editReply(message).catch(() => {});
    } else if (interaction.replied) {
      // Interaction already acknowledged
    } else {
      await interaction.reply({
        ...message,
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
});

// ==============================
// HTTP KEEP ALIVE
// ==============================

http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8'
  });

  res.end('📻 Boombox V2 is Online!');
}).listen(PORT, () => {
  console.log(`HTTP Server listening on port ${PORT}`);
});

// ==============================
// LOGIN
// ==============================

client.login(TOKEN);

// ==============================
// SHUTDOWN
// ==============================

async function shutdown() {
  console.log('Shutting down Boombox...');

  for (const state of guildPlayers.values()) {
    stopMusic(state);

    if (state.connection) {
      state.connection.destroy();
    }
  }

  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
