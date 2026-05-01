## for Solaris
# Set the path for Mesa here:
MESAPATH = /usr/local/mesa

# Set the path for X11 here:
X11PATH = /usr/X11R5

# Set the path for GLUT here:
GLUTPATH = /usr/local/glut

GL_LIB = libGL.a
GLU_LIB = libGLU.a
GLUT_LIB = libglut.a
TK_LIB = libtk.a
AUX_LIB = libaux.a
CC = gcc
CPP = g++
#CFLAGS = -O3 -DSHM -DSUNOS4
CFLAGS =
MAKELIB = ar ruv
RANLIB = ranlib
INCDIR = -I.
LIBS = -L/usr/ucblib -lucb -lsocket
XLIBS = -L$(X11PATH)/lib -lX11 -lXext -lXmu -lXt -lXi 
GL_INCDIR = -I$(MESAPATH)/include -I$(X11PATH)/include -I$(GLUTPATH)/include
GL_LIBS = -L$(MESAPATH)/lib -L$(GLUTPATH)/lib -lglut -lGLU -lGL  $(XLIBS)
LIB_DEP = $(MESAPATH)/lib/$(GL_LIB) $(MESAPATH)/lib/$(GLU_LIB) $(MESAPATH)/lib/$(TK_LIB) $(MESAPATH)/lib/$(AUX_LIB)



##### RULES #####

.SUFFIXES:
.SUFFIXES: .c .o .cpp


.c.o:
	$(CC) $(INCDIR) $(GL_INCDIR) $(CFLAGS) -c $<

.c: 
	$(CC) $(INCDIR) $(GL_INCDIR) $(LIBS) $(GL_LIBS) $(CFLAG) $< -o ../bin/$@ -lm

.cpp.o:
	$(CPP) -DUNIX -I. $(CFLAGS) -c $<



##### TARGETS #####

#VAROBJFILES contains file that need recompile for different block size
VAROBJFILES = dikelign.o strip.o padi.o farm.o slab.o highrice.o block.o
OBJFILES = vecmath.o misc.o initdata.o data.o doublist.o kdtree.o index.o \
	   common.o
HFILES = vecmath.h misc.h vortex.h initdata.h data.h dikelign.h strip.h \
	 padi.h farm.h doublist.h slab.h highrice.h block.h common.h pcvalues.h

# various tools to help developing asc
TOOLS = gendata pcxpal strpnorm size cube plantout meshcvt

all:	asc1 asc2 asc4 asc8 viewtri $(TOOLS)

library: libasc1 libasc2 libasc4 libasc8 libasc16

clean:
	-rm *.o core

realclean:
	-rm $(PROGS)
	-rm *.o *~

targets: $(PROGS)


asc1:	asc.h $(OBJFILES) $(HFILES) asc.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c dikelign.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c strip.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c slab.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c farm.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c highrice.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c block.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c padi.cpp
	$(CPP) -DUNIX -DASCHEADER1 $(OBJFILES) $(VAROBJFILES) -o ../bin/$@ asc.cpp -lm

asc2:	asc.h $(OBJFILES) $(HFILES) asc.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c dikelign.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c strip.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c slab.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c farm.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c highrice.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c block.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c padi.cpp
	$(CPP) -DUNIX -DASCHEADER2 $(OBJFILES) $(VAROBJFILES) -o ../bin/$@ asc.cpp -lm

asc4:	asc.h $(OBJFILES) $(HFILES) asc.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c dikelign.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c strip.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c slab.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c farm.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c highrice.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c block.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c padi.cpp
	$(CPP) -DUNIX -DASCHEADER4 $(OBJFILES) $(VAROBJFILES) -o ../bin/$@ asc.cpp -lm

asc8:	asc.h $(OBJFILES) $(HFILES) asc.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c dikelign.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c strip.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c slab.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c farm.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c highrice.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c block.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c padi.cpp
	$(CPP) -DUNIX -DASCHEADER8 $(OBJFILES) $(VAROBJFILES) -o ../bin/$@ asc.cpp -lm

asc16:	asc.h $(OBJFILES) $(HFILES) asc.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c dikelign.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c strip.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c slab.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c farm.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c highrice.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c block.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c padi.cpp
	$(CPP) -DUNIX -DASCHEADER16 $(OBJFILES) $(VAROBJFILES) -o ../bin/$@ asc.cpp -lm

libasc1: asc.h $(OBJFILES) $(HFILES) 
	$(CPP) -DUNIX -DASCHEADER1 -c dikelign.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c strip.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c slab.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c farm.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c highrice.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c block.cpp
	$(CPP) -DUNIX -DASCHEADER1 -c padi.cpp
	ar cur ../lib/$@.a $(OBJFILES) $(VAROBJFILES) 

libasc2: asc.h $(OBJFILES) $(HFILES) 
	$(CPP) -DUNIX -DASCHEADER2 -c dikelign.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c strip.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c slab.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c farm.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c highrice.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c block.cpp
	$(CPP) -DUNIX -DASCHEADER2 -c padi.cpp
	ar cur ../lib/$@.a $(OBJFILES) $(VAROBJFILES) 

libasc4: asc.h $(OBJFILES) $(HFILES) 
	$(CPP) -DUNIX -DASCHEADER4 -c dikelign.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c strip.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c slab.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c farm.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c highrice.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c block.cpp
	$(CPP) -DUNIX -DASCHEADER4 -c padi.cpp
	ar cur ../lib/$@.a $(OBJFILES) $(VAROBJFILES) 

libasc8: asc.h $(OBJFILES) $(HFILES) 
	$(CPP) -DUNIX -DASCHEADER8 -c dikelign.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c strip.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c slab.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c farm.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c highrice.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c block.cpp
	$(CPP) -DUNIX -DASCHEADER8 -c padi.cpp
	ar cur ../lib/$@.a $(OBJFILES) $(VAROBJFILES) 

libasc16: asc.h $(OBJFILES) $(HFILES) 
	$(CPP) -DUNIX -DASCHEADER16 -c dikelign.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c strip.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c slab.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c farm.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c highrice.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c block.cpp
	$(CPP) -DUNIX -DASCHEADER16 -c padi.cpp
	ar cur ../lib/$@.a $(OBJFILES) $(VAROBJFILES) 


gendata: tools/gendata.o initdata.o common.o $(HFILES)
	$(CPP) -I. initdata.o common.o -o ../bin/$@ tools/$@.cpp -lm

genkdtree: tools/genkdtre.o initdata.o index.o kdtree.o common.o $(HFILES)
	$(CPP) -I. initdata.o index.o kdtree.o common.o -o ../bin/$@ tools/genkdtre.cpp -lm

pcxpal:	tools/pcxpal.cpp
	$(CC) -DUNIX -o ../bin/$@ tools/$@.cpp

viewtri: viewtri.cpp trackball.o trackball.h vecmath.h vecmath.o common.o
	$(CC) $(INCDIR) $(GL_INCDIR) $(LIBS) $(CFLAGS) viewtri.cpp $(GL_LIBS) trackball.o vecmath.o common.o -o ../bin/viewtri -lm 

meshcvt: tools/meshcvt.cpp vecmath.o vecmath.h
	$(CPP) -I. -o ../bin/$@ tools/$@.cpp vecmath.o -lm
