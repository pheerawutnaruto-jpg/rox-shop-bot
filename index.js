const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  MessageFlags,
  AttachmentBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  FileBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@discordjs/voice');
const path = require('path');
const songs = require('./songs.json');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const player = createAudioPlayer();
let currentConnection = null;

client.once('ready', async () => {
  console.log(`📻 Boombox V2 (Spotify Style) พร้อมทำงานแล้วในชื่อ ${client.user.tag}!`);

  const command = new SlashCommandBuilder()
    .setName('boombox')
    .setDescription('เปิดแผงควบคุม Boombox สไตล์ Components V2 สุดล้ำ!');

  await client.application.commands.create(command);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.guild) return;

  // 1. เมื่อพิมพ์ /boombox ส่งแผง Components V2
  if (interaction.isChatInputCommand() && interaction.commandName === 'boombox') {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: '⚠️ คุณต้องเข้าห้องเสียง (Voice Channel) ก่อนหยิบ Boombox ออกมาครับ!', flags: [MessageFlags.Ephemeral] });
    }

    // ตัวอย่างไฟล์แนบสำหรับ FileBuilder
    const sampleFile = new AttachmentBuilder(Buffer.from('ยินดีต้อนรับสู่ระบบ Boombox V2'), {
      name: 'boombox-info.txt'
    });

    // Components V2 Elements
    const headerText = new TextDisplayBuilder()
      .setContent('## 📻 Roblox Style Boombox (Components V2)\nตู้เพลงดีไซน์ใหม่ล่าสุด เลือกเพลงได้สะดวกเหมือนสตรีมมิ่งชั้นนำ!');

    const divider = new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Large);

    const sectionInfo = new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('**สถานะเครื่องเล่น:** พร้อมเปิดเพลง\n*เลือกเพลงจากเมนูด้านล่างหรือกดปุ่มควบคุมได้เลย*')
      )
      .setThumbnailAccessory(
        new ThumbnailBuilder()
          .setURL('https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4')
          .setDescription('Boombox Icon')
      );

    const fileComponent = new FileBuilder()
      .setURL('attachment://boombox-info.txt');

    // สร้าง Dropdown Menu เลือกเพลงจาก songs.json
    const selectOptions = Object.entries(songs).map(([id, info]) => 
      new StringSelectMenuOptionBuilder()
        .setLabel(info.name)
        .setDescription(`รหัสเพลง: ${id}`)
        .setValue(id)
    );

    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('v2_select_song')
        .setPlaceholder('🎧 เลือกเพลงจาก Boombox...')
        .addOptions(selectOptions)
    );

    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('v2_pause')
        .setLabel('Pause / Resume')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⏯️'),
      new ButtonBuilder()
        .setCustomId('v2_stop')
        .setLabel('เก็บ Boombox')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('⏹️')
    );

    // รวมร่างทั้งหมดลงใน Container หลัก
    const mainContainer = new ContainerBuilder()
      .setAccentColor(0x1DB954) // สีเขียวสไตล์ Spotify
      .addTextDisplayComponents(headerText)
      .addSeparatorComponents(divider)
      .addSectionComponents(sectionInfo)
      .addFileComponents(fileComponent)
      .addSeparatorComponents(divider)
      .addActionRowComponents(selectRow, buttonRow);

    await interaction.reply({
      components: [mainContainer],
      files: [sampleFile],
      flags: [MessageFlags.IsComponentsV2]
    });
  }

  // 2. เมื่อเลือกเพลงจาก Dropdown Menu ใน Components V2
  if (interaction.isStringSelectMenu() && interaction.customId === 'v2_select_song') {
    const songId = interaction.values[0];
    const songData = songs[songId];
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      return interaction.reply({ content: '⚠️ คุณต้องเข้าห้องเสียงก่อนเลือกเพลง!', flags: [MessageFlags.Ephemeral] });
    }

    currentConnection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
    });

    const filePath = path.join(__dirname, 'songs', songData.file);
    const resource = createAudioResource(filePath);

    player.play(resource);
    currentConnection.subscribe(player);

    await interaction.reply({
      content: `🎶 กำลังเปิดเพลง: **${songData.name}** (เลือกโดย ${interaction.user})`,
      flags: [MessageFlags.Ephemeral]
    });
  }

  // 3. เมื่อกดปุ่มควบคุม (Pause / Stop)
  if (interaction.isButton()) {
    if (interaction.customId === 'v2_pause') {
      if (player.state.status === 'playing') {
        player.pause();
        await interaction.reply({ content: '⏸️ พักเพลงชั่วคราว', flags: [MessageFlags.Ephemeral] });
      } else if (player.state.status === 'paused') {
        player.unpause();
        await interaction.reply({ content: '▶️ เล่นเพลงต่อ', flags: [MessageFlags.Ephemeral] });
      } else {
        await interaction.reply({ content: '⚠️ ยังไม่มีเพลงกำลังเล่นอยู่', flags: [MessageFlags.Ephemeral] });
      }
    } else if (interaction.customId === 'v2_stop') {
      player.stop();
      if (currentConnection) {
        currentConnection.destroy();
        currentConnection = null;
      }
      await interaction.reply({ content: '⏹️ ปิดและเก็บ Boombox เรียบร้อยครับ', flags: [MessageFlags.Ephemeral] });
    }
  }
});

// ระบบกันบอทหลับบน Render
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Boombox V2 Components is Alive!');
}).listen(process.env.PORT || 3000);

client.login(process.env.BOT_TOKEN);
