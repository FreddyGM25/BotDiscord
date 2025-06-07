require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, Collection } = require('discord.js');
const { createAudioPlayer, createAudioResource, joinVoiceChannel, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');
const fs = require('fs');
const schedule = require('node-schedule');
const express = require('express');
const app = express();

// Configuración del bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// Prefijo para comandos desde .env
const prefix = process.env.PREFIX || '!';

// Colección para almacenar colas de música por servidor
const queues = new Collection();

// Conexiones de voz por servidor
const connections = new Collection();

// Reproductor de audio por servidor
const players = new Collection();

// Cargar frases desde el archivo JSON
let frases = [];
try {
  frases = JSON.parse(fs.readFileSync('./frases_motivacionales.json', 'utf8'));
} catch (error) {
  console.error('Error al cargar el archivo de frases:', error);
  // Crear archivo de frases si no existe
  const frasesIniciales = {
    frases: [
      "El éxito no es definitivo, el fracaso no es fatal: lo que cuenta es el coraje para continuar.",
      "La única forma de hacer un gran trabajo es amar lo que haces.",
      "No importa lo lento que vayas, siempre y cuando no te detengas."
    ]
  };
  fs.writeFileSync('./frases_motivacionales.json', JSON.stringify(frasesIniciales, null, 2));
  frases = frasesIniciales;
}

// Función para obtener una frase aleatoria
function getFraseAleatoria() {
  if (frases.frases && frases.frases.length > 0) {
    return frases.frases[Math.floor(Math.random() * frases.frases.length)];
  }
  return "¡Que tengas un excelente día!";
}

// Función para programar frases diarias
function programarFrasesDiarias() {
  const channelId = process.env.DAILY_PHRASES_CHANNEL_ID;
  if (channelId) {
    schedule.scheduleJob('0 8 * * *', async () => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel) {
          const frase = getFraseAleatoria();
          const embed = new EmbedBuilder()
            .setTitle('🌅 Frase del Día')
            .setDescription(frase)
            .setColor('#FFD700')
            .setTimestamp();
          
          await channel.send({ embeds: [embed] });
        }
      } catch (error) {
        console.error('Error al enviar frase diaria:', error);
      }
    });
    console.log('Frases diarias configuradas para el canal ID:', channelId);
  } else {
    console.log('No se ha configurado un canal para frases diarias. Usa !setfraseschannel en Discord.');
  }
}

// Función para reproducir música
async function playMusic(guildId) {
  const queue = queues.get(guildId);
  if (!queue || queue.length === 0) return;

  const song = queue[0];
  const connection = connections.get(guildId);
  let player = players.get(guildId);

  if (!player) {
    player = createAudioPlayer();
    players.set(guildId, player);
  }

  try {
    console.log('Intentando reproducir:', song.url);
    
    // Verificar que la conexión esté lista
    if (connection.state.status !== VoiceConnectionStatus.Ready) {
      await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    }
    
    const stream = ytdl(song.url, {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25
    });
    
    const resource = createAudioResource(stream, {
      inputType: 'arbitrary',
      inlineVolume: true
    });
    
    resource.volume?.setVolume(0.5);
    
    player.play(resource);
    connection.subscribe(player);

    // Crear embed de reproducción
    const embed = new EmbedBuilder()
      .setTitle('🎵 Suenalaaaa!')
      .setDescription(`**${song.title}**`)
      .addFields(
        { name: 'Duración', value: song.duration, inline: true },
        { name: 'La Pidio este veneco', value: song.requestedBy, inline: true }
      )
      .setThumbnail(song.thumbnail)
      .setColor('#00FF00');

    song.textChannel.send({ embeds: [embed] });

  } catch (error) {
    console.error('Error al reproducir música:', error);
    song.textChannel.send('❌ Error al reproducir la canción. Intentando con la siguiente...');
    
    // Remover la canción problemática y continuar
    queue.shift();
    if (queue.length > 0) {
      setTimeout(() => playMusic(guildId), 1000);
    }
  }

  player.on(AudioPlayerStatus.Idle, () => {
    queue.shift();
    if (queue.length > 0) {
      setTimeout(() => playMusic(guildId), 1000);
    } else {
      song.textChannel.send('✅ Se acabo esta vaina.');
    }
  });

  player.on('error', error => {
    console.error('Error en el reproductor:', error);
    queue.shift();
    if (queue.length > 0) {
      setTimeout(() => playMusic(guildId), 1000);
    }
  });
}

// Evento cuando el bot está listo
client.once('ready', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  
  client.user.setActivity('🎵 Música para todos', { type: ActivityType.Listening });
  
  programarFrasesDiarias();
});

// Evento para procesar mensajes
client.on('messageCreate', async message => {
  if (message.author.bot || !message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // Comando para reproducir música: !musica o !m
  if (command === 'musica' || command === 'm') {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('Debes estar en un canal de voz para usar este comando.');
    }

    if (!args.length) {
      return message.reply('Debes proporcionar una URL de YouTube o un término de búsqueda.');
    }

    try {
      let song;
      const input = args.join(' ');

      // Verificar si es una URL de YouTube
      if (ytdl.validateURL(input)) {
        // console.log('URL válida detectada:', input);
        const songInfo = await ytdl.getInfo(input);
        
        song = {
          title: songInfo.videoDetails.title,
          url: songInfo.videoDetails.video_url,
          duration: formatDuration(parseInt(songInfo.videoDetails.lengthSeconds)),
          thumbnail: songInfo.videoDetails.thumbnails[0]?.url || '',
          requestedBy: message.author.username,
          textChannel: message.channel
        };
      } else {
        // console.log('Buscando:', input);
        const searchResults = await yts(input);
        
        if (!searchResults.videos.length) {
          return message.reply('No se encontraron resultados para tu búsqueda.');
        }
        
        const video = searchResults.videos[0];
        // console.log('Video encontrado:', video.title, video.url);
        
        song = {
          title: video.title,
          url: video.url,
          duration: video.duration.timestamp || 'Desconocida',
          thumbnail: video.thumbnail || '',
          requestedBy: message.author.username,
          textChannel: message.channel
        };
      }

    //   console.log('Canción preparada:', song);

      // Crear o actualizar la cola de reproducción
      if (!queues.has(message.guild.id)) {
        queues.set(message.guild.id, []);
      }

      const queue = queues.get(message.guild.id);
      queue.push(song);

      // Conectar al canal de voz si no está conectado
      if (!connections.has(message.guild.id)) {
        try {
          const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
          });
          
          // Esperar a que la conexión esté lista
          await entersState(connection, VoiceConnectionStatus.Ready, 30000);
          
          connections.set(message.guild.id, connection);
          
          connection.on('error', error => {
            console.error('Error de conexión de voz:', error);
          });
          
        } catch (error) {
          console.error('Error al conectar al canal de voz:', error);
          return message.reply('❌ No pude conectarme al canal de voz. Inténtalo de nuevo.');
        }
      }

      if (queue.length === 1) {
        playMusic(message.guild.id);
      } else {
        const embed = new EmbedBuilder()
          .setTitle('📝 Canción añadida a la cola')
          .setDescription(`**${song.title}**`)
          .addFields(
            { name: 'Posición en cola', value: `${queue.length}`, inline: true },
            { name: 'Duración', value: song.duration, inline: true },
            { name: 'Solicitado por', value: song.requestedBy, inline: true }
          )
          .setThumbnail(song.thumbnail)
          .setColor('#FFA500');

        message.channel.send({ embeds: [embed] });
      }

    } catch (error) {
      console.error('Error en comando de música:', error);
      message.reply('❌ Hubo un error al procesar tu solicitud. Inténtalo de nuevo.');
    }
  }

  // Comando para saltar canción: !skip
  else if (command === 'skip') {
    if (!message.member.voice.channel) {
      return message.reply('Debes estar en un canal de voz para usar este comando.');
    }

    if (!queues.has(message.guild.id) || queues.get(message.guild.id).length === 0) {
      return message.reply('No hay canciones en la cola para saltar.');
    }

    if (players.has(message.guild.id)) {
      players.get(message.guild.id).stop();
      message.reply('⏭️ Canción saltada.');
    }
  }

  // Comando para detener la reproducción: !stop
  else if (command === 'stop') {
    if (!message.member.voice.channel) {
      return message.reply('Debes estar en un canal de voz para usar este comando.');
    }

    if (connections.has(message.guild.id)) {
      queues.set(message.guild.id, []);
      if (players.has(message.guild.id)) {
        players.get(message.guild.id).stop();
      }
      connections.get(message.guild.id).destroy();
      connections.delete(message.guild.id);
      players.delete(message.guild.id);
      message.reply('⏹️ Reproducción detenida y cola limpiada.');
    } else {
      message.reply('No estoy reproduciendo música actualmente.');
    }
  }

  // Comando para ver la cola: !list o !queue
  else if (command === 'list' || command === 'queue') {
    if (!queues.has(message.guild.id) || queues.get(message.guild.id).length === 0) {
      return message.reply('No hay canciones en la cola.');
    }

    const queue = queues.get(message.guild.id);
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('🎵 Cola de reproducción')
      .setDescription(`**Reproduciendo ahora:** [${queue[0].title}](${queue[0].url})`);

    if (queue.length > 1) {
      let queueList = '';
      for (let i = 1; i < queue.length && i < 10; i++) {
        queueList += `${i}. [${queue[i].title}](${queue[i].url}) - Solicitado por: ${queue[i].requestedBy}\n`;
      }
      embed.addFields({ name: 'Próximas canciones', value: queueList || 'No hay más canciones en la cola.' });
    }

    message.channel.send({ embeds: [embed] });
  }

  // Comando para configurar el canal de frases diarias: !setfraseschannel
  else if (command === 'setfraseschannel') {
    if (!message.member.permissions.has('ADMINISTRATOR')) {
      return message.reply('Necesitas permisos de administrador para usar este comando.');
    }

    const channelId = message.channel.id;
    programarFraseDiaria(channelId);
    message.reply(`Canal configurado para recibir frases diarias: <#${channelId}>`);
  }

  // Comando para agregar una frase: !addfrase
  else if (command === 'addfrase') {
    if (!message.member.permissions.has('ADMINISTRATOR')) {
      return message.reply('Necesitas permisos de administrador para usar este comando.');
    }

    const nuevaFrase = args.join(' ');
    if (!nuevaFrase) {
      return message.reply('Debes proporcionar una frase para agregar.');
    }

    try {
      if (!frases.frases) frases.frases = [];
      frases.frases.push(nuevaFrase);
      fs.writeFileSync('./frases_motivacionales.json', JSON.stringify(frases, null, 2));
      message.reply(`Frase agregada: "${nuevaFrase}"`);
    } catch (error) {
      console.error('Error al agregar frase:', error);
      message.reply('Ocurrió un error al agregar la frase.');
    }
  }

  // Comando para obtener una frase aleatoria: !frase
  else if (command === 'frase') {
    const frase = getFraseAleatoria();
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('Ecualiza tu Factous')
      .setDescription(frase)
      .setTimestamp();
    message.channel.send({ embeds: [embed] });
  }
});

// Función para formatear la duración
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// Iniciar sesión con el token del bot desde .env
client.login(process.env.DISCORD_TOKEN);

app.get('/', (req, res) => res.send('Bot activo'));
app.listen(3000, () => console.log('Web de keep-alive activa'));