**Slides**

https://docs.google.com/presentation/d/1Queydzl_UnLVbgEBDZYny3ODVkn8RNLNToNLfNF5iCQ/edit?usp=sharing

# Agenda

## Intro ~ 10 min

Cliente 

Equipo

Problema / Que hacemos

Como trabajamos

## Proyectos ~ 20 min

### Metrique ~ 5 min Tina - Facu Mendi

Mostrar demo grabada

### Symposium ~ 5 min - Facu Luzko

Mostrar demo grabada 

### Dial9 ~ lo que sobre - Fran - Juli ~ 10 min

Muy por arriba que joraca es tokio, cómo nació dial9, y qué hicimos para 0.5

Demo en vivo

## Preguntas

```
**1. El cliente

* ¿Quién es el cliente?** AWS
*** ¿A qué se dedica?** Amazon Web Services, es una filial de Amazon que proporciona plataformas de computación en la nube y API bajo demanda a particulares, empresas y gobiernos.
*** ¿En qué industria opera?** IT
*** ¿Cuál es su tamaño o contexto (si se puede compartir)?** Gigante

**2. El equipo

* Breve presentación.** Facundo Luzko, Facundo Mendizabal, Agostina Camacho, Franco Profeti, Julián Montes de Oca
*** Roles que existen en el equipo.**
	No tenemos roles definidos pero sí areas de enfoque: Facu Luzko contribuye a Sympsoium, el resto nos dedicamos a Dial9 y Metrique.
*** Particularidades o cambios recientes.**
	Estamos viendo de crecer el equipo ya que hay mucho trabajo por hacer y proyectos muy interesantes.

**3. El problema que resolvemos

* ¿Qué necesidad o problema tenía el cliente?** El equipo de Rust Platform (2-3 devs de AWS) que se encarga de ayudar a la adopción de Rust en AWS y a la mejora de el ecosistema Rust en general, necesitaba manos extra para evolucionar librerías de AWS en librerías de uso más general y de manera OSS.
*** ¿Por qué nació este proyecto?** A través de Pasto en contacto con Niko Matsakis, buscando colaborar Wye <> AWS.
*** ¿Qué impacto busca generar?

4. Qué hacemos

* ¿Qué construimos o mantenemos?** Actualmente dial9, metrique y tokio-metrics, librerías de observabilidad/telemetría.
*** ¿Qué funcionalidades o productos abarca el equipo?
* ¿Cómo encaja nuestro trabajo dentro del negocio del cliente?** El equipo de rust platform considera como "customers" a desarrolladores que utilizan nuestras herramientas. Teniéndose internal costumers (otros equipos en AWS), o external (otras librerías o empresas que usan dial9)

**5. Cómo trabajamos con el cliente

* Tipo de relación (staff augmentation, equipo dedicado, proyecto cerrado, consultoría, etc.).** Staff augmentation
*** ¿Cómo es la dinámica del día a día?** No seguimos un proceso scrum (no hay dailies, planning, refinement, etc.). Nos reunimos una vez a la semana, y nos comunicamos a diario de manera async. 
*** ¿Cómo se organiza el trabajo y la comunicación?** Una vez a la semana hacemos sync en meeting para discutir prioridades, mantenemos un backlog organizado y usualmente cada uno tiene una vertical de trabajo a la cuál se dedica y ya sabe que trabajo tendrá a futuro (desde AWS se espera mucha autonomía y auto-organización/ownership sobre los sub-proyectos).

**6. Aspectos técnicos

* Stack tecnológico.** Rust, mucho uso de tokio.
*** Arquitectura o decisiones relevantes.
* Desafíos técnicos interesantes.**

	Metrique: emisión de métricas con el menor overhead posible, lo cual require ser muy cautoleso con el manejo de memoria. E.j. producimos JSON de una manera muy manual intentando ser lo más zero-copy posible.
	
	Dial9: instrumentación de aplicaciones rust y runtimes de tokio, observando y grabando eventos para todo lo que ocurre en la aplicación, puede incluir CPU samples, MEM profiling, etc. Esto implica que toda instrumentación debe ser muy barata tanto en memoria como en disco, nunca hacer panic en producción, y no generar ningún tipo de contención u otra forma de overhead.

*** Herramientas o prácticas destacables (incluyendo uso de IA si aporta valor).**

Dial9/Metrique:
****- Uso de Shuttle para mockear operaciones concurrentes
- CI bastante completa incluyendo benchmarking de performance contando instrucciones (iai-callgrind), muchos testes, chequeos de docs, SEMVER, UI, etc.

Symposium: ___

**7. El valor que agregamos

* ¿Qué hacemos especialmente bien?** Hemos producido un montón de features en poco tiempo y grandes refactors. Ha mejorado un montón todo lo que es testing/CI desde que llegamos. 
*** ¿Qué reconoce o destaca el cliente?** En un principio velocity, más últimamente el nivel técnico de las implementaciones y el trabajo de investigación.
*** Casos concretos donde hayamos generado impacto.**
Metrique: trabajo en benchmarking, fuzz testing y shuttle testing (concurrencia) que ha encontrado varios bugs existentes y mejorado mucho la robustez de la librería.

Dial9: similar a metrique, más: recientemente lanzamos v0.5 que incluye muchas features nuevas y una gran reestructura de los crates principales que permite desacoplar dial9 de tokio y utilizarse para otro montón de casos de uso que no requiren tokio. Empresas como AWS, ERSC, Meta y OpenAI han requerido features que hemos implementado como CPU Profiling en ambientes con acceso a kernel restringido, buffering en memoria sin acceso a disco, instrumentación de networking en linux, etc.
En general a través de varias iteraciones de varios en el equipo se han mejorado muchíismo las APIs públicas de dial9

*** Logros recientes.**

Lo mismo que arriba

**8. En qué estamos hoy

* Principales iniciativas actuales.**
	Estabilizar v0.5 en dial9
	
	Comienza la colaboración en Symposium
	
	Se investiga sobre los posibles nuevos proyectos.	
	
*** Próximos hitos importantes.** TBD
*** Desafíos que vienen.** TBD
```
