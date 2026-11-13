const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const path = require('path');
const songs = require('./songs.json');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates // สำคัญมาก: ต้องเปิดเพื่อให้บอทรู้ว่าเราอยู่ห้องเสียงไหน
    ]
});

const player = createAudioPlayer();

client.once('ready', () => {
    console.log(`📻 Boombox พร้อมทำงานแล้วในชื่อ ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // คำสั่งดูรายการเพลงทั้งหมด: !list
    if (message.content === '!list') {
        let listText = '📻 **รายการเพลงใน Boombox:**\n';
        for (const [id, info] of Object.entries(songs)) {
            listText += `\`${id}\` - ${info.name}\n`;
        }
        listText += '\n*พิมพ์ `!bb <รหัสเพลง>` เพื่อเปิดเพลง (เช่น `!bb 101`)*';
        return message.reply(listText);
    }

    // คำสั่งเปิดเพลงด้วยรหัส ID: !bb 101
    if (message.content.startsWith('!bb ')) {
        const songId = message.content.split(' ')[1];
        const songData = songs[songId];

        if (!songData) {
            return message.reply('❌ ไม่พบรหัสเพลงนี้ใน Boombox! ลองพิมพ์ `!list` เพื่อดูรหัสเพลงครับ');
        }

        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.reply('⚠️ คุณต้องเข้าห้องเสียง (Voice Channel) ก่อนถึงจะเปิด Boombox ได้ครับ!');
        }

        // เชื่อมต่อเข้าห้องเสียง
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
        });

        // ดึงไฟล์เสียงจากโฟลเดอร์ songs/ มาเล่น
        const filePath = path.join(__dirname, 'songs', songData.file);
        const resource = createAudioResource(filePath);

        player.play(resource);
        connection.subscribe(player);

        message.reply(`🎶 **Boombox กำลังเล่น:** \`[${songId}]\` ${songData.name}`);
    }
});

// ใส่ Token บอทของคุณตรงนี้ (แนะนำให้ใส่ผ่าน Environment Variable บนโฮสต์เพื่อความปลอดภัย)
client.login(process.env.BOT_TOKEN);
