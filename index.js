require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data'); // Add this to your dependencies

// URLs de webhooks de MAKE
const WEBHOOK_CONSULTA = process.env.WEBHOOK_CONSULTA_LINK; 
const WEBHOOK_AGENDA = process.env.WEBHOOK_AGENDA_LINK;

// Inicializar cliente de WhatsApp
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
        type: 'none'
    }
});

// Estado de las conversaciones
const conversationStates = {};
// Servicios ofrecidos: Se inicializa vacío y se cargará desde el PDF
let servicios = {};
// Horarios disponibles: Se inicializa vacío y se cargará desde el PDF
let horariosDisponibles = [];
// Datos de la empresa extraídos del PDF
let empresaInfo = {};
// ID del chat de ChatPDF
let chatPdfSourceId = '';
// API Key para ChatPDF


const CHATPDF_API_KEY = process.env.CHATPDF_API_KEY; // Configura esto en tu .env
// ID del chat de ChatPDF preexistente donde ya está cargado el PDF
const CHATPDF_EXISTING_SOURCE_ID = process.env.CHATPDF_SOURCE_ID;

// Función para chatear con el PDF usando ChatPDF

async function chatWithPDF(message) {
    try {
        if (!chatPdfSourceId) {
            console.error('No hay un ID de fuente de ChatPDF configurado');
            throw new Error('ChatPDF Source ID no configurado');
        }
        
        // console.log("Enviando a ChatPDF:", message); // Log del prompt enviado

        const response = await axios.post('https://api.chatpdf.com/v1/chats/message', {
            sourceId: chatPdfSourceId,
            messages: [
                {
                    role: 'user',
                    content: message
                }
            ]
        }, {
            headers: {
                'x-api-key': CHATPDF_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        console.log("Respuesta de ChatPDF:", response.data.content); // Log de la respuesta recibida
        return response.data.content;
    } catch (error) {
        console.error('Error al consultar ChatPDF:', error.response?.data || error.message);
        if (error.response) {
            console.error('Respuesta de error completa:', error.response);
        }
        throw new Error(`Error de ChatPDF: ${error.response?.data?.message || error.message}`);
    }
}

// Función para procesar mensajes con ChatPDF
async function procesarMensajeConChatPDF(messageContent, conversationHistory) {
    try {
        // Prepara información de contexto para ChatPDF
        const contextInfo = `
        Tú eres un asistente virtual para ${empresaInfo.nombre || 'la empresa'}. Tu trabajo es ayudar a clientes respondiendo preguntas basadas en el documento PDF proporcionado y agendando citas si te lo piden.

        IMPORTANTE: Si el cliente expresa interés claro en AGENDAR, RESERVAR o PEDIR una CITA, debes identificarlo y RESPONDER CON LA PALABRA CLAVE "INICIAR_AGENDA" al principio de tu mensaje, seguido de una respuesta amable iniciando el proceso.
        Si el mensaje es parte de un flujo de agenda ya iniciado (pidiendo nombre, telefono, servicio, fecha, hora, confirmacion), identifica qué información está proporcionando o qué paso sigue y RESPONDE CON LA PALABRA CLAVE correspondiente al inicio (ej: NOMBRE_RECIBIDO, TELEFONO_RECIBIDO, SERVICIO_RECIBIDO, FECHA_RECIBIDA, HORA_RECIBIDA, CONFIRMAR_CITA, CANCELAR_PROCESO).

        Usa la información del PDF para responder preguntas sobre la empresa, servicios, horarios, etc. Sé cordial y profesional.
        `;
        
        // Create the prompt for ChatPDF
        let prompt = contextInfo + "\n\n";
        
        // Add conversation history if available
        if (conversationHistory && conversationHistory.length > 0) {
            prompt += "Historial de conversación reciente:\n";
            conversationHistory.slice(-5).forEach(msg => {
                prompt += `${msg.role === 'user' ? 'Cliente' : 'Asistente'}: ${msg.content}\n`;
            });
            prompt += "\n";
        }
        
        // Add the current message
        prompt += `Mensaje actual del cliente: ${messageContent}\n\n`;
        prompt += "Responde de manera concisa. Si es una pregunta general, usa la información del PDF. Si es parte del agendamiento, usa la palabra clave apropiada al inicio como se indicó.";
        
        // Query ChatPDF
        const chatPdfResponse = await chatWithPDF(prompt);

        // Verificar si la respuesta es un mensaje de error de chatWithPDF
        if (chatPdfResponse.startsWith('Error:')) {
            return {
                intent: 'error',
                response: chatPdfResponse, // Propaga el mensaje de error
                originalResponse: chatPdfResponse
            };
       }
        
        // Procesar las palabras clave en la respuesta
        let intent = 'informacion'; // Por defecto
        let processedResponse = chatPdfResponse;

        const keywords = {
            'INICIAR_AGENDA': 'agenda.cita',
            'NOMBRE_RECIBIDO': 'agenda.nombre',
            'TELEFONO_RECIBIDO': 'agenda.telefono',
            'SERVICIO_RECIBIDO': 'agenda.servicio',
            'FECHA_RECIBIDA': 'agenda.fecha',
            'HORA_RECIBIDA': 'agenda.hora',
            'CONFIRMAR_CITA': 'agenda.confirmar',
            'CANCELAR_PROCESO': 'agenda.cancelar'
        };
        
        for (const keyword in keywords) {
            if (chatPdfResponse.startsWith(keyword)) {
                intent = keywords[keyword];
                processedResponse = chatPdfResponse.substring(keyword.length).trim();
                break; // Asume solo una palabra clave al inicio
            }
        }

        return {
            intent: intent,
            response: processedResponse,
            originalResponse: chatPdfResponse // Guardamos la respuesta original por si necesitamos extraer info específica
        };
    } catch (error) {
        console.error('Error al procesar mensaje con ChatPDF:', error);
        return {
            intent: 'error',
            response: 'Lo siento, estoy experimentando problemas técnicos para entender tu mensaje. ¿Puedes intentarlo nuevamente?'
        };
    }
}

// Generar QR para conectar WhatsApp
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Escanea el código QR con tu teléfono para iniciar sesión');
});

client.on('ready', async () => {
    console.log('Bot de WhatsApp listo y conectado');
    
    // Usar el ID de fuente existente en lugar de cargar un nuevo PDF
    chatPdfSourceId = CHATPDF_EXISTING_SOURCE_ID;
    
    if (chatPdfSourceId) {
        console.log('Usando ID de fuente de ChatPDF existente:', chatPdfSourceId);
        
        // Extraer información básica del PDF para 'empresaInfo'
        try {
            const infoExtractionResult = await chatWithPDF(
                "Extrae la siguiente información del PDF y preséntala estrictamente en formato JSON: " +
                "nombre de la empresa (clave 'nombre'), dirección (clave 'direccion'), teléfono (clave 'telefono'), " +
                "descripción breve (clave 'descripcion'), horarios generales de atención (clave 'horarios'), " +
                "y política de cancelación si existe (clave 'politicaCancelacion'). " +
                "Solo devuelve el objeto JSON, sin ningún texto introductorio o explicaciones adicionales."
            );

             // Verificar si la respuesta es un mensaje de error de chatWithPDF
            if (infoExtractionResult.startsWith('Error:')) {
                console.error("Error al extraer info de empresa:", infoExtractionResult);
                // Decidir cómo manejar esto. ¿Usar valores por defecto? ¿Detener el bot?
                // Por ahora, lo dejamos vacío, las funciones que lo usen deberán verificar.
                empresaInfo = {};
            } else {
                try {
                    // Intenta parsear la respuesta JSON
                    const jsonMatch = infoExtractionResult.match(/\{[\s\S]*\}/); // Intenta encontrar un JSON en la respuesta
                    if (jsonMatch) {
                        empresaInfo = JSON.parse(jsonMatch[0]);
                        // console.log('Información estructurada de la empresa procesada:', empresaInfo);
                    } else {
                         console.warn('No se encontró un JSON válido en la respuesta para info de empresa:', infoExtractionResult);
                         empresaInfo = {}; // Dejar vacío si no se pudo parsear
                    }
                } catch (parseError) {
                    console.warn('Error al parsear la respuesta JSON para info de empresa:', parseError, "Respuesta recibida:", infoExtractionResult);
                    empresaInfo = {};
                }
            }
        } catch (error) {
            console.error('Error crítico al extraer información inicial con ChatPDF:', error);
            empresaInfo = {};
        }
    } else {
        console.error('ERROR: Falta CHATPDF_API_KEY o CHATPDF_SOURCE_ID en el archivo .env');
        console.log('El bot no podrá usar la información del PDF. Se usarán valores vacíos.');
        empresaInfo = {};
    }
});

// Función para consultar disponibilidad mediante webhook de MAKE
async function verificarDisponibilidad(fecha, hora) {
    try {
        // console.log(`Consultando disponibilidad para fecha: ${fecha}, hora: ${hora}`);
        const response = await axios.post(WEBHOOK_CONSULTA, {
            fecha: fecha, // Asegúrate que Make espere YYYY-MM-DD
            hora: hora   // Asegúrate que Make espere HH:MM
        });

        console.log("Respuesta completa de disponibilidad Make:", JSON.stringify(response.data)); // Log para ver la respuesta completa

        // --- INICIO LÓGICA MODIFICADA ---
        // Verificar si la respuesta es un array no vacío
        if (response.data && Array.isArray(response.data) && response.data.length > 0) {

            // Usar 'every' para chequear si TODOS los elementos indican disponibilidad
            const todosDisponibles = response.data.every(item => {
                // Verificar que cada item sea un objeto, tenga la propiedad 'disponible'
                // y que su valor (convertido a string y minúsculas) sea 'true'
                return typeof item === 'object' &&
                       item !== null &&
                       item.hasOwnProperty('disponible') &&
                       String(item.disponible).toLowerCase() === 'true';
            });

            if (todosDisponibles) {
                // console.log("Evaluación de disponibilidad: Todos los slots están disponibles.");
                return true; // Solo retorna true si TODOS cumplen la condición
            } else {
                // console.log("Evaluación de disponibilidad: Al menos un slot NO está disponible.");
                return false; // Si al menos uno no cumple, retorna false
            }

        } else {
            // Si la respuesta no es un array, está vacía, o tiene un formato inesperado
            console.error('Formato de respuesta de disponibilidad no reconocido o inesperado:', response.data);
            return false; // Asumir no disponible si la respuesta no es clara o está vacía
        }
        // --- FIN LÓGICA MODIFICADA ---

    } catch (error) {
        console.error('Error al verificar disponibilidad via Make:', error.response?.data || error.message);
        return false; // Asumir no disponible en caso de error de conexión/AXIOS
    }
}

// Función para crear cita mediante webhook de MAKE
async function crearCita(nombre, telefono, servicioNombre,servicioDuracion, fecha, hora) {
    try {
            // console.log(`Creando cita para: ${nombre}, servicio: ${servicioNombre}, fecha: ${fecha}, hora: ${hora}`);
            const response = await axios.post(WEBHOOK_AGENDA, {
                nombre: nombre,
                telefono: telefono,
                servicio: servicioNombre, // Enviar nombre
                duracion: servicioDuracion, // Enviar duración
                fecha: fecha, // Asegúrate que Make espere YYYY-MM-DD
                hora: hora   // Asegúrate que Make espere HH:MM
            });
    
            let resultadoExitoso = false; // Variable para guardar si fue exitoso

            if (response.data) {
                let resultadoObjeto = null;

                // 1. Comprobar si es un ARRAY con al menos un elemento
                if (Array.isArray(response.data) && response.data.length > 0) {
                    resultadoObjeto = response.data[0]; // Usar el primer elemento
                }
                // 2. Si no es array, comprobar si es un OBJETO directamente
                else if (typeof response.data === 'object' && response.data !== null && !Array.isArray(response.data)) {
                    resultadoObjeto = response.data; // Usar el objeto directamente
                }

                // 3. Si tenemos un objeto (de cualquiera de las formas anteriores), verificar la propiedad
                if (resultadoObjeto && (resultadoObjeto.hasOwnProperty('exito') || resultadoObjeto.hasOwnProperty('success'))) {
                    const exitoValue = resultadoObjeto.exito ?? resultadoObjeto.success;
                    console.log("Respuesta de creación de cita Make procesada:", exitoValue);
                    // Comprobar si el valor es true (como booleano o string)
                    resultadoExitoso = String(exitoValue).toLowerCase() === 'true';
                }
            }

            // 4. Si no se marcó como exitoso después de las comprobaciones, mostrar error
            if (!resultadoExitoso) {
                 console.error('Formato de respuesta de creación de cita no reconocido o no exitoso:', response.data);
            }

            return resultadoExitoso; // Devolver true o false
    
        } catch (error) {
            console.error('Error al crear la cita via Make:', error.response?.data || error.message);
            return false;
        }
}

// Manejar mensajes entrantes
client.on('message', async (message) => {
    const senderId = message.from;
    const messageContent = message.body.trim();
    
    // Inicializar estado de conversación si es nueva
    if (!conversationStates[senderId]) {
        conversationStates[senderId] = {
            step: 'inicial',
            conversationHistory: [],
            nombre: '',
            telefono: '',
            servicio: '',
            fecha: '',
            hora: '',
            lastActivity: Date.now()
        };
        
        // Mensaje de bienvenida usando ChatPDF
        const bienvenidaPrompt = `Un cliente (${senderId}) acaba de iniciar una conversación. Dale un mensaje de bienvenida cálido mencionando el nombre de la empresa "${empresaInfo.nombre || 'nuestra empresa'}" e indícale brevemente que puede consultar información o agendar una cita.`;        
        const chatPdfResult = await procesarMensajeConChatPDF(bienvenidaPrompt, []);
        
        await client.sendMessage(senderId, chatPdfResult.response);
        
        // Guardar la interacción en el historial
        conversationStates[senderId].conversationHistory.push(
            { role: 'assistant', content: chatPdfResult.response }
        );
        return;
    }
    
    const state = conversationStates[senderId];
    state.lastActivity = Date.now();
    
    // Guardar el mensaje del usuario en el historial de conversación
    state.conversationHistory.push(
        { role: 'user', content: messageContent }
    );
    
    // Procesar el mensaje con ChatPDF
    const chatPdfResult = await procesarMensajeConChatPDF(messageContent, state.conversationHistory);
    
    // Si ChatPDF devuelve un error, mostrarlo y no continuar
    if (chatPdfResult.intent === 'error') {
        await client.sendMessage(senderId, chatPdfResult.response);
        // Podríamos resetear el estado o mantenerlo? Por ahora lo mantenemos.
        return;
    }

    // Manejar el flujo de la conversación
    switch (state.step) {
        case 'inicial':
            if (chatPdfResult.intent === 'agenda.cita') {
                state.step = 'nombre';
                const msg = `${chatPdfResult.response}\n\nPara comenzar con la reserva, por favor dime tu nombre completo:`;
                await client.sendMessage(senderId, msg);
                state.conversationHistory.push({ role: 'assistant', content: msg });
            } else {
                // Responder con la información general proporcionada por ChatPDF
                await client.sendMessage(senderId, chatPdfResult.response);
                state.conversationHistory.push({ role: 'assistant', content: chatPdfResult.response });
            }
            break;

        case 'nombre':
            // Asumimos que el messageContent es el nombre, ChatPDF ya dio una respuesta genérica
            state.nombre = messageContent;
            try {
                // senderId ya contiene message.from (ej: "573001234567@c.us")
                if (senderId && senderId.includes('@')) {
                   state.telefono = senderId.split('@')[0]; // Extrae "573001234567"
                //    console.log(`Número de teléfono capturado automáticamente para ${state.nombre}: ${state.telefono}`);
                } else {
                   // Si senderId no tiene el formato esperado, podríamos manejarlo
                   console.warn(`No se pudo extraer el número del senderId: ${senderId}. Se dejará vacío.`);
                   state.telefono = ''; // O asignar un valor por defecto o manejar el error
                }
           } catch(e) {
               console.error("Error al procesar senderId para teléfono:", e);
               state.telefono = ''; // Asegurarse de tener un valor por defecto en caso de error
           }
            state.step = 'servicio';

            // Cargar y mostrar servicios
            try {
                const serviciosPrompt = `Extrae únicamente la lista de servicios ofrecidos por la empresa con sus duraciones en minutos del PDF. Devuelve el resultado estrictamente como un objeto JSON. Las claves deben ser números secuenciales como strings (empezando en "1") y los valores deben ser objetos con las claves "nombre" (string) y "duracion" (número). Ejemplo: {"1": {"nombre": "Corte de Cabello", "duracion": 30}, "2": {"nombre": "Tinte", "duracion": 120}}. No incluyas NADA MÁS que el objeto JSON en tu respuesta.`;
                const serviciosResult = await chatWithPDF(serviciosPrompt);

                if (serviciosResult.startsWith('Error:')) {
                    await client.sendMessage(senderId, `Lo siento, ${state.nombre}, no pude obtener la lista de servicios en este momento. Por favor, inténtalo más tarde.`);
                    // Quizás volver a 'inicial' o manejar de otra forma
                    delete conversationStates[senderId]; // Ejemplo: terminar conversación
                    return;
                }

                // Extraer JSON de la respuesta (más robusto)
                let serviciosCargados = {};
                const jsonMatchServicios = serviciosResult.match(/\{[\s\S]*\}/);
                if (jsonMatchServicios) {
                     serviciosCargados = JSON.parse(jsonMatchServicios[0]);
                } else {
                     throw new Error("No se encontró JSON en la respuesta de servicios.");
                }

                // Verificar que 'serviciosCargados' no esté vacío
                if (Object.keys(serviciosCargados).length === 0) {
                     throw new Error("La lista de servicios extraída está vacía.");
                }

                // IMPORTANTE: Asignar a la variable global 'servicios' para usarla en otros pasos
                servicios = serviciosCargados;

                // console.log("Servicios cargados dinámicamente:", servicios);

                // Construir y enviar menú de servicios
                let menuServicios = `Perfecto, ${state.nombre}. ¿Qué servicio deseas agendar?\nResponde con el número correspondiente:\n\n`;
                for (const [id, servicio] of Object.entries(servicios)) {
                    menuServicios += `${id}. ${servicio.nombre} (${servicio.duracion} min)\n`;
                }
                await client.sendMessage(senderId, menuServicios);
                state.conversationHistory.push({ role: 'assistant', content: menuServicios });

            } catch (error) {
                console.error("Error al cargar/parsear servicios desde ChatPDF:", error, "Respuesta recibida:", typeof serviciosResult !== 'undefined' ? serviciosResult : 'undefined');
                await client.sendMessage(senderId, `Lo siento ${state.nombre}, tuve problemas para obtener la lista de servicios. Por favor, intenta de nuevo más tarde.`);
                // Resetear estado o manejar error
                delete conversationStates[senderId]; // Ejemplo: terminar conversación por error crítico
            }
            break;

        case 'servicio':
            const servicioSeleccionadoId = messageContent; // El usuario debe responder con el número (ID)

            // Validar que la selección exista en los servicios cargados dinámicamente
            if (servicios[servicioSeleccionadoId]) {
                state.servicio = servicioSeleccionadoId; // Guardar el ID del servicio
                state.step = 'fecha';
                const msgFecha = `Entendido. Has seleccionado "${servicios[state.servicio].nombre}".\n\n¿Para qué fecha deseas agendar? Por favor, usa el formato DD/MM/YYYY (ejemplo: 01/04/2025):`;
                await client.sendMessage(senderId, msgFecha);
                state.conversationHistory.push({ role: 'assistant', content: msgFecha });
            } else {
                // Pedir de nuevo si la opción no es válida
                let errorMsg = 'Por favor, selecciona una opción válida respondiendo solo con el número del servicio:\n\n';
                 for (const [id, servicio] of Object.entries(servicios)) {
                    errorMsg += `${id}. ${servicio.nombre} (${servicio.duracion} min)\n`;
                }
                await client.sendMessage(senderId, errorMsg);
                // No cambiar state.step, se mantiene en 'servicio'
            }
            break;

        case 'fecha':
            const regexFecha = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
            const matchFecha = messageContent.match(regexFecha);

            if (matchFecha) {
                const dia = matchFecha[1].padStart(2, '0');
                const mes = matchFecha[2].padStart(2, '0');
                const anio = matchFecha[3];
                const fechaFormateada = `${anio}-${mes}-${dia}`; // Formato YYYY-MM-DD

                // Validar si la fecha es razonable (ej. no en el pasado lejano, no inválida como 31/02)
                const hoy = new Date();
                hoy.setHours(0,0,0,0); // Comparar solo fechas
                const fechaSeleccionada = new Date(anio, mes - 1, dia); // Mes es 0-indexado

                if (isNaN(fechaSeleccionada.getTime()) || fechaSeleccionada < hoy) {
                     await client.sendMessage(senderId, 'La fecha ingresada no es válida o es una fecha pasada. Por favor, ingresa una fecha futura en formato DD/MM/YYYY:');
                     return; // Mantener paso 'fecha'
                }


                state.fecha = fechaFormateada;
                state.step = 'hora';

                // --- NUEVO: Cargar horarios desde PDF ---
                try {
                     const horariosPrompt = `Extrae únicamente la lista de horarios generales de atención disponibles mencionados en el PDF. Devuelve el resultado estrictamente como un array JSON de strings, donde cada string es una hora en formato "HH:MM", ten en cuenta que si ves algo como 10:00 am a 12:00 pm o 10:00 am - 12:00 pm es un rango de horarios de una hora por ejemplo 10:00am, 11:00am, 12:00pm. Ejemplo: ["10:00", "11:00", "12:00", "14:00", "15:00"]. No incluyas NADA MÁS que el array JSON en tu respuesta.`;
                     const horariosResult = await chatWithPDF(horariosPrompt);

                     if (horariosResult.startsWith('Error:')) {
                        await client.sendMessage(senderId, `Lo siento, ${state.nombre}, no pude obtener la lista de horarios generales en este momento. Por favor, inténtalo más tarde.`);
                        state.step = 'fecha'; // Volver al paso anterior
                        return;
                    }

                    const jsonMatchHorarios = horariosResult.match(/\[[\s\S]*\]/); // Buscar un array JSON
                     if (!jsonMatchHorarios) {
                          throw new Error("No se encontró JSON array en la respuesta de horarios.");
                     }

                     horariosDisponibles = JSON.parse(jsonMatchHorarios[0]); // Poblar la variable global

                     if (!Array.isArray(horariosDisponibles) || horariosDisponibles.length === 0) {
                         throw new Error("La lista de horarios extraída está vacía o no es un array.");
                     }

                    //  console.log("Horarios cargados dinámicamente:", horariosDisponibles);

                     // Construir y enviar menú de horarios
                     let menuHorarios = `¡Genial! Para la fecha ${dia}/${mes}/${anio}, estos son nuestros horarios generales de atención. Por favor, selecciona una hora respondiendo con el formato HH:MM (ejemplo: 11:00):\n\n`;
                     for (const horario of horariosDisponibles) {
                         menuHorarios += `- ${horario}\n`;
                     }
                     menuHorarios += "\n*Nota: La disponibilidad final se confirmará en el siguiente paso.*";
                     await client.sendMessage(senderId, menuHorarios);
                     state.conversationHistory.push({ role: 'assistant', content: menuHorarios });

                 } catch (error) {
                     console.error("Error al cargar/parsear horarios desde ChatPDF:", error, "Respuesta recibida:", horariosResult);
                     await client.sendMessage(senderId, `Lo siento ${state.nombre}, tuve problemas para obtener los horarios. Por favor, intenta seleccionar la fecha de nuevo.`);
                     state.step = 'fecha'; // Revertir al paso de fecha
                 }
                // --- FIN NUEVO ---

            } else {
                await client.sendMessage(senderId, 'Formato de fecha incorrecto. Por favor, usa DD/MM/YYYY (ejemplo: 01/04/2025):');
                // Mantener state.step en 'fecha'
            }
            break;

        case 'hora':
            const regexHora = /^(\d{1,2}):(\d{2})$/;
            const matchHora = messageContent.match(regexHora);
            let horaSeleccionada = '';

            if (matchHora) {
                horaSeleccionada = `${matchHora[1].padStart(2, '0')}:${matchHora[2]}`; // Formato HH:MM

                // Validar si la hora está en la lista cargada dinámicamente
                if (horariosDisponibles.includes(horaSeleccionada)) {
                     state.hora = horaSeleccionada;

                     // Verificar disponibilidad REAL con MAKE antes de confirmar
                     try {
                         console.log(`Verificando disponibilidad real para ${state.fecha} a las ${state.hora}...`);
                         const disponible = await verificarDisponibilidad(state.fecha, state.hora);

                         if (disponible) {
                             state.step = 'confirmacion';
                             const servicioInfo = servicios[state.servicio]; // Obtener info del servicio seleccionado
                             const msgConfirmacion = `📝 *Resumen de tu cita:*\n\n` +
                                 `Nombre: ${state.nombre}\n` +
                                 `Teléfono: ${state.telefono}\n` +
                                 `Servicio: ${servicioInfo.nombre}\n` +
                                 `Fecha: ${state.fecha.split('-').reverse().join('/')} (${state.fecha})\n` + // Mostrar DD/MM/YYYY y YYYY-MM-DD
                                 `Hora: ${state.hora}\n\n` +
                                 `Para confirmar tu cita, escribe *CONFIRMAR*. Para cancelar, escribe *CANCELAR*.`;
                             await client.sendMessage(senderId, msgConfirmacion);
                             state.conversationHistory.push({ role: 'assistant', content: msgConfirmacion });
                         } else {
                             // Horario no disponible según MAKE
                             let msgNoDisponible = `Lo sentimos, el horario de las ${state.hora} para el ${state.fecha.split('-').reverse().join('/')} ya no está disponible.\n\nPor favor, elige otro horario de la lista:\n\n`;
                              for (const horario of horariosDisponibles) {
                                 msgNoDisponible += `- ${horario}\n`;
                             }
                             await client.sendMessage(senderId, msgNoDisponible);
                             state.hora = ''; // Limpiar hora seleccionada
                             state.step = 'hora'; // Mantenerse en el paso de hora
                             state.conversationHistory.push({ role: 'assistant', content: msgNoDisponible });
                         }
                     } catch (error) {
                         console.error("Error al verificar disponibilidad con Make:", error);
                         await client.sendMessage(senderId, 'Hubo un problema al verificar la disponibilidad en nuestro sistema. Por favor, intenta seleccionar la hora nuevamente.');
                         state.step = 'hora'; // Reintentar paso de hora
                     }
                 } else {
                     // La hora escrita no está en la lista general
                     let errorMsgHora = 'La hora ingresada no coincide con nuestros horarios generales. Por favor, selecciona una hora válida de la lista (formato HH:MM):\n\n';
                     for (const horario of horariosDisponibles) {
                         errorMsgHora += `- ${horario}\n`;
                     }
                     await client.sendMessage(senderId, errorMsgHora);
                     // Mantener state.step en 'hora'
                 }
             } else {
                 // Formato de hora incorrecto
                 await client.sendMessage(senderId, 'Formato de hora incorrecto. Por favor, usa HH:MM (ejemplo: 14:30):');
                 // Mantener state.step en 'hora'
             }
            break;

        case 'confirmacion':
            const confirmacionTexto = messageContent.toLowerCase();
            let confirmado = false;
            let cancelado = false;

            if (confirmacionTexto === 'confirmar' || chatPdfResult.intent === 'agenda.confirmar') {
                confirmado = true;
            } else if (confirmacionTexto === 'cancelar' || chatPdfResult.intent === 'agenda.cancelar') {
                cancelado = true;
            } else {
                 await client.sendMessage(senderId, `No entendí tu respuesta. Por favor, escribe *CONFIRMAR* para agendar tu cita o *CANCELAR* para detener el proceso.`);
                 return; // Mantener paso 'confirmacion'
            }


            if (confirmado) {
                 try {
                     const servicioInfo = servicios[state.servicio]; // Obtener nombre y duración
                     const resultadoCita = await crearCita(
                         state.nombre,
                         state.telefono,
                         servicioInfo.nombre, // Enviar nombre del servicio
                         servicioInfo.duracion, // Enviar duración
                         state.fecha,
                         state.hora
                     );

                     if (resultadoCita) {
                         // Usar ChatPDF para generar un mensaje de confirmación personalizado si se quiere
                         const confirmacionFinalPrompt = `La cita para ${state.nombre} (servicio: ${servicioInfo.nombre}) el ${state.fecha.split('-').reverse().join('/')} a las ${state.hora} ha sido AGENDADA EXITOSAMENTE en el sistema. Genera un mensaje final de confirmación muy amable para el cliente. Si el PDF menciona una política de cancelación (clave 'politicaCancelacion' en la info de la empresa: ${JSON.stringify(empresaInfo)}), inclúyela brevemente. Deséale un buen día.`;
                         const mensajeConfirmacionFinal = await procesarMensajeConChatPDF(confirmacionFinalPrompt, state.conversationHistory); // Usar procesar para limpieza

                         await client.sendMessage(senderId, `✅ *¡Cita confirmada!*\n\n${mensajeConfirmacionFinal.response}`);
                         state.conversationHistory.push({ role: 'assistant', content: `✅ *¡Cita confirmada!*\n\n${mensajeConfirmacionFinal.response}` });
                     } else {
                         await client.sendMessage(senderId, `❌ Lo sentimos, ${state.nombre}, hubo un problema al registrar tu cita en nuestro sistema. Por favor, intenta nuevamente o contáctanos directamente.`);
                         state.conversationHistory.push({ role: 'assistant', content: `❌ Error al registrar cita en sistema.` });
                     }
                 } catch (error) {
                     console.error("Error en el proceso final de confirmación/creación:", error);
                     await client.sendMessage(senderId, `❌ Hubo un error inesperado al procesar tu cita, ${state.nombre}. Por favor, inténtalo más tarde o contáctanos.`);
                     state.conversationHistory.push({ role: 'assistant', content: `❌ Error inesperado en confirmación.` });
                 }
                 // Reiniciar estado después de confirmar (o fallar al confirmar)
                 delete conversationStates[senderId];

             } else if (cancelado) {
                 // Usar ChatPDF para mensaje de cancelación amable
                 const cancelacionPrompt = `El cliente (${state.nombre}) ha decidido CANCELAR el proceso de reserva de cita en el último paso. Genera un mensaje breve y amable indicando que el proceso se ha cancelado y que puede contactarnos de nuevo cuando lo desee.`;
                 const mensajeCancelacion = await procesarMensajeConChatPDF(cancelacionPrompt, state.conversationHistory);

                 await client.sendMessage(senderId, mensajeCancelacion.response);
                 state.conversationHistory.push({ role: 'assistant', content: mensajeCancelacion.response });
                 // Reiniciar estado
                 delete conversationStates[senderId];
             }
            break;

        default:
            // Estado desconocido, reiniciar?
            console.log(`Estado desconocido "${state.step}" para ${senderId}. Respondiendo con ChatPDF genérico.`);
            await client.sendMessage(senderId, chatPdfResult.response); // Responder con la interpretación de ChatPDF
            state.conversationHistory.push({ role: 'assistant', content: chatPdfResult.response });
            // Podríamos reiniciar el estado aquí si se considera un error
            // delete conversationStates[senderId];
            break;
    }

     // Limitar tamaño del historial para evitar prompts muy largos a ChatPDF
     if (state && state.conversationHistory.length > 10) {
        state.conversationHistory = state.conversationHistory.slice(-10); // Mantener solo los últimos 10 mensajes
     }

});

// Función para limpiar historial de conversaciones antiguas (cada hora)
setInterval(() => {
    const ahora = Date.now();
    let cleanedCount = 0;
    for (const [senderId, state] of Object.entries(conversationStates)) {
        // Limpiar si lleva más de 1 hora inactiva
        if (state.lastActivity && (ahora - state.lastActivity > 3600000)) {
            delete conversationStates[senderId];
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) {
        console.log(`Limpieza automática: ${cleanedCount} conversaciones inactivas eliminadas.`);
    }
}, 3600000); // Ejecutar cada hora


// Función para manejar el cierre del bot sin eliminar la fuente de ChatPDF
async function handleShutdown() {
    console.log('Cerrando bot de WhatsApp...');
    // No eliminamos la fuente de ChatPDF ya que es preexistente
    process.exit();
}

// Manejar cierre del proceso
process.on('SIGINT', handleShutdown);

// Iniciar el cliente de WhatsApp
client.initialize();