const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios'); // Para hacer llamadas HTTP a los webhooks
const fs = require('fs');
const path = require('path');

// URLs de webhooks de MAKE (reemplazar con tus URLs reales)
const WEBHOOK_CONSULTA = 'https://hook.us2.make.com/ka77ngdhtnzo3m3drpt1g63m31j89u7c';
const WEBHOOK_AGENDA = 'https://hook.us2.make.com/ucxoghvjkuqb71xdliml3ipcnodi5fi9';

// Inicializar cliente de WhatsApp con opciones adicionales
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    },
    webVersionCache: {
        type: 'none'  // Desactivar el caché de versión web que está causando el error
    }
});

// Estado de las conversaciones (para seguir el flujo de reserva)
const conversationStates = {};

// Servicios ofrecidos por la peluquería con sus duraciones (en minutos)
const servicios = {
    "1": { nombre: "Corte de cabello", duracion: 30 },
    "2": { nombre: "Tinte", duracion: 120 },
    "3": { nombre: "Peinado", duracion: 45 },
    "4": { nombre: "Tratamiento capilar", duracion: 60 },
    "5": { nombre: "Manicura", duracion: 45 }
};

// Horarios disponibles de la peluquería
const horariosDisponibles = ["10:00", "11:00", "12:00", "13:00", "15:00", "16:00", "17:00", "18:00"];

// Generar QR para conectar WhatsApp
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Escanea el código QR con tu teléfono para iniciar sesión');
});

client.on('ready', () => {
    console.log('Bot de WhatsApp listo y conectado');
});

// Función para consultar disponibilidad mediante webhook de MAKE
async function verificarDisponibilidad(fecha, hora) {
    try {
        console.log(`Consultando disponibilidad para fecha: ${fecha}, hora: ${hora}`);
        
        const response = await axios.post(WEBHOOK_CONSULTA, {
            fecha: fecha,
            hora: hora
        });
        
        console.log("Respuesta recibida del webhook:", JSON.stringify(response.data));
        
        // Manejar el formato [ { disponible: 'true' } ]
        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
            const disponibleValue = response.data[0].disponible;
            return disponibleValue === true || disponibleValue === "true";
        }
        
        console.error('Formato de respuesta no reconocido:', response.data);
        return false;
    } catch (error) {
        console.error('Error al verificar disponibilidad:', error.message);
        return false;
    }
}

// Función para crear cita mediante webhook de MAKE
async function crearCita(nombre, telefono, servicio, fecha, hora) {
    try {
        console.log(`Creando cita para: ${nombre}, servicio: ${servicios[servicio].nombre}, fecha: ${fecha}, hora: ${hora}`);
        
        const response = await axios.post(WEBHOOK_AGENDA, {
            nombre: nombre,
            telefono: telefono,
            servicio: servicios[servicio].nombre,
            duracion: servicios[servicio].duracion,
            fecha: fecha,
            hora: hora
        });
        
        console.log("Respuesta recibida del webhook de creación:", JSON.stringify(response.data));
        
        // Asumimos un formato similar para la respuesta de creación
        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
            const exitoValue = response.data[0].exito || response.data[0].success;
            return exitoValue === true || exitoValue === "true";
        }
        
        // Si el formato es diferente pero recibimos un estado 200, asumimos éxito
        return response.status === 200;
    } catch (error) {
        console.error('Error al crear la cita:', error.message);
        return false;
    }
}

// Manejar mensajes entrantes
client.on('message', async (message) => {
    const senderId = message.from;
    const messageContent = message.body.trim().toLowerCase();
    
    // Inicializar estado de conversación si es nueva
    if (!conversationStates[senderId]) {
        conversationStates[senderId] = {
            step: 'inicio',
            nombre: '',
            telefono: '',
            servicio: '',
            fecha: '',
            hora: ''
        };
        
        await client.sendMessage(senderId, 
            '👋 ¡Bienvenido/a a Peluquería Estilo! Soy tu asistente virtual para agendar citas.\n\n' +
            'Para comenzar, por favor escribe tu nombre completo:'
        );
        return;
    }
    
    const state = conversationStates[senderId];
    
    // Manejar diferentes estados de la conversación
    switch (state.step) {
        case 'inicio':
            state.nombre = messageContent;
            state.step = 'telefono';
            await client.sendMessage(senderId, 
                `¡Gracias ${state.nombre}! Por favor, comparte tu número de teléfono de contacto:`
            );
            break;
            
        case 'telefono':
            state.telefono = messageContent;
            state.step = 'servicio';
            
            // Mostrar menú de servicios
            let menuServicios = '¿Qué servicio deseas agendar? Responde con el número correspondiente:\n\n';
            for (const [id, servicio] of Object.entries(servicios)) {
                menuServicios += `${id}. ${servicio.nombre} (${servicio.duracion} min)\n`;
            }
            
            await client.sendMessage(senderId, menuServicios);
            break;
            
        case 'servicio':
            if (!servicios[messageContent]) {
                await client.sendMessage(senderId, 
                    'Por favor, selecciona una opción válida (1-5):'
                );
                return;
            }
            
            state.servicio = messageContent;
            state.step = 'fecha';
            
            await client.sendMessage(senderId, 
                'Perfecto. ¿Para qué fecha deseas agendar? Por favor, usa el formato DD/MM/YYYY (ejemplo: 10/03/2025):'
            );
            break;
            
        case 'fecha':
            // Validar formato de fecha
            const regexFecha = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
            if (!regexFecha.test(messageContent)) {
                await client.sendMessage(senderId, 
                    'Por favor, ingresa la fecha en formato DD/MM/YYYY (ejemplo: 10/03/2025):'
                );
                return;
            }
            
            // Convertir a formato YYYY-MM-DD para MAKE
            const partesFecha = messageContent.split('/');
            const fechaFormateada = `${partesFecha[2]}-${partesFecha[1].padStart(2, '0')}-${partesFecha[0].padStart(2, '0')}`;
            
            state.fecha = fechaFormateada;
            state.step = 'hora';
            
            // Mostrar horarios disponibles
            let menuHorarios = 'Selecciona un horario disponible (responde con la hora exacta):\n\n';
            for (const horario of horariosDisponibles) {
                menuHorarios += `- ${horario}\n`;
            }
            
            await client.sendMessage(senderId, menuHorarios);
            break;
            
        case 'hora':
            if (!horariosDisponibles.includes(messageContent)) {
                await client.sendMessage(senderId, 
                    'Por favor, selecciona una hora válida de la lista proporcionada.'
                );
                return;
            }
            
            state.hora = messageContent;
            state.step = 'confirmacion';
            
            try {
                // Verificar disponibilidad a través del webhook de MAKE
                console.log(`Verificando disponibilidad para ${state.fecha} a las ${state.hora}...`);
                const disponible = await verificarDisponibilidad(state.fecha, state.hora);
                console.log(`Resultado de disponibilidad: ${disponible}`);
                
                if (!disponible) {
                    await client.sendMessage(senderId, 
                        'Lo sentimos, ese horario ya está ocupado. Por favor, selecciona otro horario:'
                    );
                    state.step = 'hora';
                    return;
                }
                
                // Mostrar resumen de la cita para confirmación
                await client.sendMessage(senderId, 
                    `📝 *Resumen de tu cita:*\n\n` +
                    `Nombre: ${state.nombre}\n` +
                    `Teléfono: ${state.telefono}\n` +
                    `Servicio: ${servicios[state.servicio].nombre}\n` +
                    `Fecha: ${state.fecha}\n` +
                    `Hora: ${state.hora}\n\n` +
                    `Para confirmar tu cita, escribe *CONFIRMAR*. Para cancelar, escribe *CANCELAR*.`
                );
            } catch (error) {
                console.error("Error en proceso de verificación:", error);
                await client.sendMessage(senderId, 
                    'Lo sentimos, hubo un problema al verificar la disponibilidad. Por favor, intenta nuevamente.'
                );
                state.step = 'hora';
            }
            break;
            
        case 'confirmacion':
            if (messageContent === 'confirmar') {
                try {
                    // Crear la cita a través del webhook de MAKE
                    console.log("Procesando confirmación de cita...");
                    const resultado = await crearCita(
                        state.nombre,
                        state.telefono,
                        state.servicio,
                        state.fecha,
                        state.hora
                    );
                    
                    if (resultado) {
                        await client.sendMessage(senderId, 
                            `✅ *¡Cita confirmada!*\n\n` +
                            `Tu cita para ${servicios[state.servicio].nombre} ha sido agendada para el ${state.fecha} a las ${state.hora}.\n\n` +
                            `Te recordaremos un día antes por este medio. Si necesitas cambiar o cancelar tu cita, por favor contáctanos con al menos 24 horas de anticipación.\n\n` +
                            `¡Gracias por elegir Peluquería Estilo!`
                        );
                    } else {
                        await client.sendMessage(senderId, 
                            `❌ Lo sentimos, hubo un problema al agendar tu cita. Por favor, intenta nuevamente o contáctanos directamente al teléfono de la peluquería.`
                        );
                    }
                } catch (error) {
                    console.error("Error en proceso de confirmación:", error);
                    await client.sendMessage(senderId, 
                        `❌ Lo sentimos, hubo un error al procesar tu cita. Por favor, intenta nuevamente o contáctanos directamente al teléfono de la peluquería.`
                    );
                }
            } else if (messageContent === 'cancelar') {
                await client.sendMessage(senderId, 
                    `Entendido, hemos cancelado el proceso de reserva. Si deseas agendar en otro momento, solo escribe "Hola" para comenzar nuevamente.`
                );
            } else {
                await client.sendMessage(senderId, 
                    `Por favor, escribe *CONFIRMAR* para agendar tu cita o *CANCELAR* para cancelar el proceso.`
                );
                return;
            }
            
            // Reiniciar el estado para futuras conversaciones
            delete conversationStates[senderId];
            break;
    }
});

// Iniciar el cliente de WhatsApp
client.initialize();