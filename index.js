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
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

const songs = require('./songs.json');

// =====================================
// CONFIG
// =====================================

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

const MAX_FILE_SIZE = 100 * 1024 * 1024;

if (!TOKEN) {
  throw new Error('ไม่พบ BOT_TOKEN ในไฟล์ .env');
}

if (!ffmpegPath) {
  throw new Error('ไม่พบ FFmpeg กรุณาติดตั้ง ffmpeg-static');
}

console.log('========== BOOMBOX DEBUG ==========');
console.log('FFmpeg:', ffmpegPath);
console.log('Songs:', Object.keys(songs).length);
console.log('===================================');

// =====================================
// DISCORD CLIENT
// =====================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// =====================================
// GUILD AUDIO STATES
// =====================================

const guildPlayers = new Map();

function getGuildState(guildId) {
  if (guildPlayers.has(guildId)) {
    return guildPlayers.get(guildId);
  }

  const player = createAudioPlayer();

  const state = {
    player,
    connection: null,
    ffmpeg: null,
    resource: null,
    currentSong: null,
    playbackId: 0,
    downloadController: null,
    tempDir: null
  };

  player.on('stateChange', (oldState, newState) => {
    console.log(
      `[${guildId}] PLAYER: ${oldState.status} -> ${newState.status}`
    );

    // เพลงจบตามปกติ
    if (
      oldState.status !== AudioPlayerStatus.Idle &&
      newState.status === AudioPlayerStatus.Idle
    ) {
      const oldResource = oldState.resource;
      const oldPlaybackId = oldResource?.metadata?.playbackId;

      // ป้องกัน Idle event ของเพลงเก่าปิดเพลงใหม่
      if (oldPlaybackId === state.playbackId) {
        stopFFmpeg(state);

        state.resource = null;
        state.currentSong = null;

        cleanupTempFile(state);
      }
    }
  });

  player.on('error', error => {
    console.error(`[${guildId}] PLAYER ERROR:`, error);

    stopMusic(state);
  });

  guildPlayers.set(guildId, state);

  return state;
}

// =====================================
// STOP FFMPEG
// =====================================

function stopFFmpeg(state) {
  const process = state.ffmpeg;

  state.ffmpeg = null;

  if (process && process.exitCode === null && !process.killed) {
    process.kill('SIGKILL');
  }
}

// =====================================
// CLEANUP TEMP FILE
// =====================================

async function cleanupTempFile(state) {
  const dir = state.tempDir;

  state.tempDir = null;

  if (dir) {
    await fs.promises.rm(dir, {
      recursive: true,
      force: true
    }).catch(error => {
      console.error('[CLEANUP ERROR]', error.message);
    });
  }
}

// =====================================
// STOP MUSIC
// =====================================

function stopMusic(state) {
  // เปลี่ยน ID เพื่อป้องกัน event เก่ารบกวนเพลงใหม่
  state.playbackId++;

  // ยกเลิกการดาวน์โหลดที่กำลังทำงาน
  if (state.downloadController) {
    state.downloadController.abort();
    state.downloadController = null;
  }

  state.player.stop();

  stopFFmpeg(state);

  state.resource = null;
  state.currentSong = null;

  cleanupTempFile(state);
}

// =====================================
// VALIDATE URL
// =====================================

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

// =====================================
// DOWNLOAD SONG
// =====================================

async function downloadSong(url, signal) {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'boombox-')
  );

  const tempFile = path.join(tempDir, 'song.mp3');

  try {
    console.log('[DOWNLOAD] Starting:', url);

    const response = await fetch(url, {
      signal,
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(
        `ดาวน์โหลดเพลงไม่สำเร็จ HTTP ${response.status}`
      );
    }

    if (!response.body) {
      throw new Error('ไม่พบข้อมูลเพลงจาก URL');
    }

    // ตรวจสอบ URL หลัง redirect ด้วย
    const finalURL = new URL(response.url);

    if (
      finalURL.protocol !== 'https:' ||
      finalURL.hostname !== 'files.catbox.moe'
    ) {
      throw new Error('URL ปลายทางดาวน์โหลดไม่ถูกต้อง');
    }

    const contentLength = Number(
      response.headers.get('content-length') || 0
    );

    if (contentLength > MAX_FILE_SIZE) {
      throw new Error('ไฟล์เพลงมีขนาดใหญ่เกิน 100 MB');
    }

    let downloadedBytes = 0;

    const sizeLimiter = new Transform({
      transform(chunk, encoding, callback) {
        downloadedBytes += chunk.length;

        if (downloadedBytes > MAX_FILE_SIZE) {
          callback(
            new Error('ไฟล์เพลงมีขนาดใหญ่เกิน 100 MB')
          );
          return;
        }

        callback(null, chunk);
      }
    });

    await pipeline(
      Readable.fromWeb(response.body),
      sizeLimiter,
      fs.createWriteStream(tempFile),
      { signal }
    );

    const stat = await fs.promises.stat(tempFile);

    if (stat.size === 0) {
      throw new Error('ไฟล์เพลงว่างเปล่า');
    }

    console.log(
      '[DOWNLOAD] Completed:',
      stat.size,
      'bytes'
    );

    return {
      tempDir,
      tempFile
    };

  } catch (error) {
    await fs.promises.rm(tempDir, {
      recursive: true,
      force: true
    }).catch(() => {});

    throw error;
  }
}

// =====================================
// PLAY SONG
// DOWNLOAD FIRST VERSION
// =====================================

async function playSong(interaction, songId) {
  const song = songs[songId];

  if (!song) {
    throw new Error('ไม่พบเพลงใน songs.json');
  }

  if (!song.file || !isValidSongURL(song.file)) {
    throw new Error('URL เพลงไม่ถูกต้อง');
  }

  const voiceChannel = interaction.member.voice.channel;

  if (!voiceChannel) {
    throw new Error('กรุณาเข้าห้องเสียงก่อน');
  }

  const guildId = interaction.guild.id;
  const state = getGuildState(guildId);

  // หยุดเพลงเก่า
  stopMusic(state);

  const playbackId = state.playbackId;

  let downloaded = null;

  try {
    // =================================
    // DOWNLOAD SONG
    // =================================

    console.log(`[${guildId}] Downloading song...`);

    const controller = new AbortController();

    state.downloadController = controller;

    try {
      downloaded = await downloadSong(
        song.file,
        controller.signal
      );

    } finally {
      if (state.downloadController === controller) {
        state.downloadController = null;
      }
    }

    // ตรวจสอบว่าเพลงยังเป็นรายการปัจจุบัน
    if (state.playbackId !== playbackId) {
      throw new Error('การเล่นเพลงถูกยกเลิก');
    }

    state.tempDir = downloaded.tempDir;

    console.log(`[${guildId}] Download completed`);

    // =================================
    // CONNECT VOICE
    // =================================

    if (
      !state.connection ||
      state.connection.state.status === VoiceConnectionStatus.Destroyed
    ) {
      state.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: true,
        debug: true
      });

      state.connection.on('error', error => {
        console.error(`[${guildId}] VOICE ERROR:`, error);
      });

    } else if (
      state.connection.joinConfig.channelId !== voiceChannel.id
    ) {
      state.connection.destroy();

      state.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: true,
        debug: true
      });

      state.connection.on('error', error => {
        console.error(`[${guildId}] VOICE ERROR:`, error);
      });
    }

    state.connection.on('stateChange', (oldState, newState) => {
      console.log(
        `[${guildId}] VOICE STATE: ${oldState.status} -> ${newState.status}`
      );
    });

    state.connection.on('debug', message => {
      console.log(`[${guildId}] VOICE DEBUG: ${message}`);
    });

    await entersState(
      state.connection,
      VoiceConnectionStatus.Ready,
      20_000
    );

    if (state.playbackId !== playbackId) {
      throw new Error('การเล่นเพลงถูกยกเลิก');
    }

    state.connection.subscribe(state.player);

    // =================================
    // START FFMPEG
    // =================================

    console.log(`[${guildId}] Starting FFmpeg...`);
    console.log(`[${guildId}] FILE: ${downloaded.tempFile}`);

    const ffmpeg = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',

      '-i', downloaded.tempFile,

      // เลือกเฉพาะเสียง ไม่เอาภาพปก
      '-map', '0:a:0',
      '-vn',

      '-acodec', 'pcm_s16le',
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

    // =================================
    // FFMPEG STDERR
    // =================================

    ffmpeg.stderr.on('data', data => {
      const output = data.toString();

      ffmpegError += output;

      if (ffmpegError.length > 5000) {
        ffmpegError = ffmpegError.slice(-5000);
      }

      console.error(
        `[${guildId}] FFMPEG:`,
        output.trim()
      );
    });

    // =================================
    // FFMPEG PROCESS ERROR
    // =================================

    ffmpeg.on('error', error => {
      console.error(
        `[${guildId}] FFMPEG SPAWN ERROR:`,
        error
      );

      if (state.ffmpeg === ffmpeg) {
        stopMusic(state);
      }
    });

    // =================================
    // FFMPEG PROCESS CLOSE
    // =================================

    ffmpeg.on('close', (code, signal) => {
      console.log(
        `[${guildId}] FFMPEG CLOSED`,
        { code, signal }
      );

      const failed = code !== 0 || signal !== null;

      if (failed) {
        console.error(
          `[${guildId}] FFMPEG DETAILS:`,
          ffmpegError
        );
      }

      if (state.ffmpeg === ffmpeg) {
        state.ffmpeg = null;

        if (failed && state.playbackId === playbackId) {
          state.player.stop();

          state.currentSong = null;
          state.resource = null;
        }
      }

      // ลบไฟล์เมื่อ FFmpeg อ่านไฟล์เสร็จ
      if (state.tempDir === downloaded.tempDir) {
        cleanupTempFile(state);
      }
    });

    // =================================
    // AUDIO RESOURCE
    // =================================

    ffmpeg.stdout.on('error', error => {
      console.error(
        `[${guildId}] FFMPEG STDOUT ERROR:`,
        error
      );
    });

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      metadata: {
        playbackId,
        songName: song.name
      }
    });

    resource.playStream.on('error', error => {
      console.error(
        `[${guildId}] RESOURCE STREAM ERROR:`,
        error
      );
    });

    state.resource = resource;

    // =================================
    // PLAY
    // =================================

    state.player.play(resource);

    console.log(`[${guildId}] PLAYING: ${song.name}`);

    return song;

  } catch (error) {
    // ห้ามหยุดเพลงใหม่ หากคำขอเก่าถูกยกเลิก
    if (state.playbackId === playbackId) {
      stopMusic(state);
    }

    // ลบไฟล์ที่ดาวน์โหลดแล้ว หากยังไม่ได้เป็นไฟล์ของเพลงปัจจุบัน
    if (
      downloaded &&
      state.tempDir !== downloaded.tempDir
    ) {
      await fs.promises.rm(downloaded.tempDir, {
        recursive: true,
        force: true
      }).catch(() => {});
    }

    throw error;
  }
}

// =====================================
// REGISTER SLASH COMMAND
// =====================================

client.once('clientReady', async () => {
  console.log('===================================');
  console.log('📻 BOOMBOX V2 ONLINE');
  console.log(`🤖 BOT: ${client.user.tag}`);
  console.log('===================================');

  try {
    const command = new SlashCommandBuilder()
      .setName('boombox')
      .setDescription('เปิดแผงควบคุม Boombox');

    await client.application.commands.create(command);

    console.log('Slash Command Registered!');

  } catch (error) {
    console.error('COMMAND REGISTER ERROR:', error);
  }
});

// =====================================
// INTERACTION HANDLER
// =====================================

client.on('interactionCreate', async interaction => {
  if (!interaction.guild) return;

  try {

    // =================================
    // BOOMBOX COMMAND
    // =================================

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

      const entries = Object.entries(songs).slice(0, 25);

      if (entries.length === 0) {
        return interaction.reply({
          content: '⚠️ ไม่มีเพลงในระบบ',
          flags: MessageFlags.Ephemeral
        });
      }

      const selectRow = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('v2_select_song')
            .setPlaceholder('🎧 เลือกเพลง')
            .addOptions(
              entries.map(([id, song]) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(song.name.slice(0, 100))
                  .setDescription(`รหัสเพลง ${id}`)
                  .setValue(id)
              )
            )
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
              'ระบบเล่นเพลงผ่าน URL Streaming\n\n' +
              '🎧 เลือกเพลงจากเมนูด้านล่าง\n' +
              '⏯️ กด Pause / Resume เพื่อควบคุม\n' +
              '⏹️ กด Stop เพื่อหยุดเพลง'
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

    // =================================
    // SELECT SONG
    // =================================

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === 'v2_select_song'
    ) {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      try {
        const songId = interaction.values[0];

        const song = await playSong(interaction, songId);

        return interaction.editReply({
          content: `🎶 กำลังเปิดเพลง **${song.name}**`
        });

      } catch (error) {
        console.error('PLAY SONG ERROR:', error);

        return interaction.editReply({
          content: `⚠️ เล่นเพลงไม่สำเร็จ: ${error.message}`
        });
      }
    }

    // =================================
    // BUTTON CONTROL
    // =================================

    if (interaction.isButton()) {
      const state = guildPlayers.get(interaction.guild.id);

      if (!state) {
        return interaction.reply({
          content: '⚠️ ยังไม่มีเครื่องเล่นเพลง',
          flags: MessageFlags.Ephemeral
        });
      }

      // ตรวจสอบว่าผู้ใช้อยู่ห้องเดียวกับบอท
      const userChannel = interaction.member.voice.channelId;
      const botChannel = state.connection?.joinConfig.channelId;

      if (!userChannel || userChannel !== botChannel) {
        return interaction.reply({
          content: '⚠️ กรุณาอยู่ห้องเสียงเดียวกับบอท',
          flags: MessageFlags.Ephemeral
        });
      }

      // =================================
      // PAUSE / RESUME
      // =================================

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

      // =================================
      // STOP
      // =================================

      if (interaction.customId === 'v2_stop') {
        stopMusic(state);

        if (state.connection) {
          state.connection.destroy();
          state.connection = null;
        }

        return interaction.reply({
          content: '⏹️ หยุดเพลงและออกจากห้องแล้ว',
          flags: MessageFlags.Ephemeral
        });
      }
    }

  } catch (error) {
    console.error('INTERACTION ERROR:', error);

    const response = {
      content: '⚠️ เกิดข้อผิดพลาดในระบบ Boombox'
    };

    if (interaction.deferred) {
      await interaction.editReply(response).catch(() => {});
    } else if (!interaction.replied) {
      await interaction.reply({
        ...response,
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
});

// =====================================
// HTTP SERVER
// =====================================

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8'
  });

  res.end('📻 BOOMBOX V2 IS ONLINE');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP Server listening on port ${PORT}`);
});

// =====================================
// SHUTDOWN
// =====================================

async function shutdown() {
  console.log('Shutting down...');

  for (const state of guildPlayers.values()) {
    stopMusic(state);

    if (state.connection) {
      state.connection.destroy();
      state.connection = null;
    }
  }

  server.close();

  client.destroy();

  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// =====================================
// LOGIN
// =====================================

client.login(TOKEN);
