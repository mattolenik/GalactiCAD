#ifndef __MISC_H
#define __MISC_H

#include <stdlib.h>
#include <stdio.h>

void GetCpuTime(float *usertime, float *systime);

#define DISPLAYTREE(a) { \
                         int di, dj; \
                         for (di=0 ; di<=NLEVEL ; di++) \
                         {                           \
                           for (dj=0 ; dj<(1<<di) ; dj++)\
                             printf("%d ", (int)(a)[(1<<di)+dj]);\
                           printf("\n");\
                         }  \
                        }

#endif

